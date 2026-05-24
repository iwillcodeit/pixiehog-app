/**
 * Backfill orchestrator — drives the Phase-1 pipeline:
 *
 *   1. preflight HogQL snapshot
 *   2. fetch exclude-set
 *   3. orders bulk op → stream JSONL → emit Order Completed/Cancelled + Order Refunded
 *   4. final per-email $identify pass (latest order wins)
 *   5. customers bulk op → authoritative $identify
 *   6. postflight HogQL snapshot
 *
 * Concurrency: callers MUST gate so only one run executes per shop at a time.
 * Resumption (NOT YET IMPLEMENTED):
 * BackfillRun stores jsonlOffsetOrders/jsonlOffsetCustomers + bulk op IDs.
 * To implement crash resumption for large historical backfills:
 * 1. On start, check findResumableRun() — if found, reuse its bulk op URL
 * 2. Pass stored offset to streamJsonl(url, { offset })
 * 3. Handle URL expiry (7 days) — re-trigger bulk op if stale
 * 4. Handle partial AssembledOrder at offset boundary (first rows may be
 *    children of a partially-assembled order — skip until next top-level order)
 * 5. UUID dedup protects Order Completed on re-run; cancellations/refunds
 *    also safe via deterministic UUIDs (generateOrderEventUUID/generateRefundUUID)
 *
 * Current state: always starts fresh. Acceptable for <1000 orders (5-20 min).
 * Required before running full-history backfill (pre-pixiehog era).
 *
 * NOTE: this file is the scaffold from the canonical plan. Verifier hooks
 * (preflight/postflight HogQL counts) and dry-run logging are stubbed where
 * marked TODO; implementation lands behind a feature flag in the next PR.
 */

import type { Shop } from "@prisma/client";
import { throttleDelay } from "./throttle";
import {
  capturePostHogEvents,
  identifyPostHog,
  type PostHogConfig,
} from "../posthog/posthog-capture";
import {
  buildCustomerIdentifyProperties,
  buildIdentifyProperties,
  resolveCustomerDistinctId,
  resolveDistinctId,
  type ShopifyCustomerPayload,
  type ShopifyOrderPayload,
} from "../posthog/identity";
import { mapOrderCompleted } from "../posthog/mappers/order-completed";
import { mapOrderCancelled } from "../posthog/mappers/order-cancelled";
import { mapRefundCreated } from "../posthog/mappers/refund-created";
import {
  generateOrderEventUUID,
  generateRefundUUID,
} from "../posthog/dedup";
import {
  type AdminGraphqlClient,
  startBulkOp,
  streamJsonl,
  waitForBulkOp,
} from "./bulk-op";
import {
  buildCustomersBulkQuery,
  buildOrdersBulkQuery,
} from "./queries";
import {
  ingestRow,
  newAssembledOrder,
  toRestCustomer,
  toRestOrder,
  toRestRefunds,
  type AssembledOrder,
  type GqlCustomerNode,
  type GqlOrderNode,
} from "./normalize";
import {
  fetchExcludeSet,
  shouldSkipOrderCompleted,
  type ExcludeSetCredentials,
} from "./exclude-set";
import {
  bumpCounters,
  recordCustomersBulkOp,
  recordOrdersBulkOp,
  recordSnapshot,
  setStatus,
} from "./state";

/**
 * Queries PostHog's HogQL API for a month-by-month, per-$lib breakdown of
 * backfill-relevant events. Called before and after the pipeline so the run
 * record contains a before/after snapshot of the project's event landscape.
 */
async function fetchEventSnapshot(
  creds: ExcludeSetCredentials,
): Promise<unknown[]> {
  const url = `${creds.apiHost.replace(/\/$/, "")}/api/projects/${creds.projectId}/query/`;
  const hogql = `
    SELECT toStartOfMonth(timestamp) AS month, properties.$lib AS lib, event, count() AS cnt
    FROM events
    WHERE event IN ('Order Completed', 'Order Cancelled', 'Order Refunded')
    GROUP BY month, lib, event
    ORDER BY month DESC
    LIMIT 1000
  `;
  const body = { query: { kind: "HogQLQuery", query: hogql } };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.personalApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `PostHog HogQL snapshot query failed: HTTP ${res.status} ${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as { results?: unknown[] };
  return json.results ?? [];
}

const LIB_NAME = "nuances-server";
const FLUSH_BATCH_SIZE = 100;
const FLUSH_THROTTLE_MS = 120;

export interface RunBackfillArgs {
  runId: string;
  shop: Shop; // local Shop record (posthogApiKey + dataCollectionStrategy)
  admin: AdminGraphqlClient;
  excludeSetCreds: ExcludeSetCredentials;
  /** Inclusive lower bound (Shopify `created_at`). null = all-time. */
  since: Date | null;
  /** Exclusive upper bound. null = no upper bound. */
  until: Date | null;
  dryRun: boolean;
}

/**
 * Build the Shopify search-syntax filter for the orders bulk op.
 * E.g. `created_at:>=2025-01-01 AND created_at:<2026-01-01`.
 */
function buildDateFilter(since: Date | null, until: Date | null): string {
  const parts: string[] = [];
  if (since) parts.push(`created_at:>=${since.toISOString()}`);
  if (until) parts.push(`created_at:<${until.toISOString()}`);
  return parts.join(" AND ");
}

interface BatchedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
  uuid?: string;
}

/** Strips PII from event properties when shop is in anonymized/consent mode. */
function stripPii(props: Record<string, unknown>): Record<string, unknown> {
  const out = { ...props };
  delete out.email;
  delete out.first_name;
  delete out.last_name;
  delete out.phone;
  delete out.tags;
  delete out.customer_orders_count;
  delete out.ordersCount;
  return out;
}

export async function runBackfill(args: RunBackfillArgs): Promise<void> {
  const { runId, shop, admin, excludeSetCreds, since, until, dryRun } = args;

  if (!shop.posthogApiKey || !shop.posthogApiHost) {
    throw new Error(`Shop ${shop.shop} missing PostHog config`);
  }

  const phConfig: PostHogConfig = {
    apiKey: shop.posthogApiKey,
    apiHost: shop.posthogApiHost,
  };
  const isAnonymous = shop.dataCollectionStrategy !== "non-anonymized";

  await setStatus(runId, "running");

  // ---- 1. preflight snapshot (non-blocking — diagnostic, not required for backfill) ----
  try {
    const preflightRows = await fetchEventSnapshot(excludeSetCreds);
    await recordSnapshot(runId, "preflight", preflightRows);
  } catch (err) {
    console.warn("[backfill] preflight snapshot failed (continuing):", err);
    await recordSnapshot(runId, "preflight", { error: String(err) });
  }

  // ---- 2. exclude-set ----
  const excludeSet = await fetchExcludeSet(excludeSetCreds);

  // ---- 3. orders bulk op ----
  const ordersFilter = buildDateFilter(since, until);
  const ordersBulkId = await startBulkOp(admin, buildOrdersBulkQuery(ordersFilter));
  await recordOrdersBulkOp(runId, ordersBulkId);
  const ordersUrl = await waitForBulkOp(admin, ordersBulkId);

  // Per-email tracking for the final identify pass — keep only the latest order
  // by processedAt/createdAt to avoid out-of-order $set thrash.
  const latestOrderByEmail = new Map<string, ShopifyOrderPayload & { __ts?: string }>();

  let pending: AssembledOrder | null = null;
  let buffer: BatchedEvent[] = [];
  let lineProcessed = 0;
  let counters = {
    ordersProcessed: 0,
    refundsProcessed: 0,
    cancellationsProcessed: 0,
    excludedAlreadyCaptured: 0,
    skippedWebOrders: 0,
    skippedNoIdentity: 0,
  };

  const backfilledTag = new Date().toISOString().slice(0, 10);
  let totalSkippedWeb = 0;
  let totalSkippedNoId = 0;

  const flush = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < FLUSH_BATCH_SIZE) return;
    if (!dryRun) {
      const tagged = buffer.map((e) => ({
        ...e,
        properties: { ...e.properties, backfilled: backfilledTag },
      }));
      const ok = await capturePostHogEvents(phConfig, tagged, { historical: true });
      if (!ok) {
        throw new Error(
          `[backfill] flush failed after retries for ${tagged.length} events at JSONL line ${lineProcessed}. Run aborted to prevent data gaps.`,
        );
      }
      // Throttle to stay under PostHog 10 req/s limit
      await throttleDelay(FLUSH_THROTTLE_MS);
    } else {
      console.log(`[backfill] dryRun flush ${buffer.length} events`, buffer.slice(0, 3));
    }
    totalSkippedWeb += counters.skippedWebOrders;
    totalSkippedNoId += counters.skippedNoIdentity;
    buffer = [];
    await bumpCounters(runId, counters, lineProcessed);
    counters = {
      ordersProcessed: 0,
      refundsProcessed: 0,
      cancellationsProcessed: 0,
      excludedAlreadyCaptured: 0,
      skippedWebOrders: 0,
      skippedNoIdentity: 0,
    };
  };

  const drain = async (assembled: AssembledOrder) => {
    const restOrder = toRestOrder(assembled);
    // NOTE: resolveDistinctId uses email as distinct_id even in anonymized mode.
    // This is acceptable for Lightinderm (non-anonymized). See TODO.md
    // "Anonymized mode distinct_id uses email" for future fix.
    const distinctId = resolveDistinctId(restOrder);
    if (!distinctId) {
      counters.skippedNoIdentity += 1;
      console.warn(`[backfill] skipped order ${restOrder.id}: no distinct_id`);
      return;
    }

    // Web orders are captured by the web pixel — never re-emit from backfill.
    // The UUID seed differs (pixel uses checkout_token, backfill uses order_id),
    // so PostHog UUID dedup cannot catch this — filtering here is the only guard.
    const isWebOrder = restOrder.source_name === "web";

    // Order Completed — skip web orders AND already-captured orders.
    const orderIdStr = String(restOrder.id);
    if (isWebOrder) {
      counters.skippedWebOrders += 1;
    } else if (!shouldSkipOrderCompleted(excludeSet, orderIdStr, LIB_NAME)) {
      let props: Record<string, unknown> = mapOrderCompleted(
        restOrder as unknown as Parameters<typeof mapOrderCompleted>[0],
        shop.shop,
      );
      if (isAnonymous) props = stripPii(props);
      buffer.push({
        event: "Order Completed",
        distinct_id: distinctId,
        properties: props,
        timestamp: restOrder.created_at,
        uuid: generateOrderEventUUID(shop.shop, null, restOrder.id, "Order Completed"),
      });
      counters.ordersProcessed += 1;
    } else {
      counters.excludedAlreadyCaptured += 1;
    }

    // Order Cancelled — skip web orders (web pixel handles its own lifecycle)
    // NOTE: UUID uses order_id seed (null checkout_token). Live webhook uses checkout_token
    // when present → UUIDs may diverge for orders with checkout_token. Safe for May 2026
    // recovery (non-web orders lack checkout_token). See TODO.md "Cancellation UUID alignment".
    if (!isWebOrder && assembled.order.cancelledAt) {
      let props: Record<string, unknown> = mapOrderCancelled(
        restOrder as unknown as Parameters<typeof mapOrderCancelled>[0],
        shop.shop,
      );
      if (isAnonymous) props = stripPii(props);
      buffer.push({
        event: "Order Cancelled",
        distinct_id: distinctId,
        properties: props,
        timestamp: assembled.order.cancelledAt,
        uuid: generateOrderEventUUID(shop.shop, null, restOrder.id, "Order Cancelled"),
      });
      counters.cancellationsProcessed += 1;
    }

    // Order Refunded — emit for ALL orders (live webhook refunds.create fires regardless of channel)
    for (const refund of toRestRefunds(assembled)) {
      const refundProps = mapRefundCreated(refund, shop.shop);
      buffer.push({
        event: "Order Refunded",
        distinct_id: distinctId,
        properties: isAnonymous ? stripPii(refundProps) : refundProps,
        timestamp: refund.created_at,
        uuid: generateRefundUUID(shop.shop, refund.id),
      });
      counters.refundsProcessed += 1;
    }

    // Track latest order per email for the final identify pass
    if (!isAnonymous && restOrder.customer?.email) {
      const email = restOrder.customer.email.toLowerCase().trim();
      const ts = restOrder.created_at ?? "";
      const prev = latestOrderByEmail.get(email);
      if (!prev || (prev.__ts ?? "") < ts) {
        latestOrderByEmail.set(email, { ...restOrder, __ts: ts });
      }
    }

    await flush(false);
  };

  for await (const { line, node } of streamJsonl(ordersUrl)) {
    lineProcessed = line;
    const decision = ingestRow(pending, node);
    if (decision.absorbed) continue;

    if (decision.isOrder) {
      if (pending) await drain(pending);
      pending = newAssembledOrder(node as unknown as GqlOrderNode);
    }
  }
  if (pending) await drain(pending);
  await flush(true);

  // ---- 4. final per-email identify pass ----
  if (!isAnonymous) {
    const identifyEvents: BatchedEvent[] = [];
    for (const [email, order] of latestOrderByEmail) {
      const { $set, $set_once } = buildIdentifyProperties(order);
      identifyEvents.push({
        event: "$identify",
        distinct_id: email,
        properties: { $set, $set_once, backfilled: backfilledTag },
        timestamp: order.__ts,
      });
    }
    for (let i = 0; i < identifyEvents.length; i += FLUSH_BATCH_SIZE) {
      const slice = identifyEvents.slice(i, i + FLUSH_BATCH_SIZE);
      if (!dryRun) {
        const ok = await capturePostHogEvents(phConfig, slice, { historical: true });
        if (!ok) {
          console.error(`[backfill] identify flush failed for slice ${i}-${i + slice.length} — NOT counted`);
        } else {
          await bumpCounters(runId, { identifiesProcessed: slice.length });
        }
      } else {
        console.log(`[backfill] dryRun identify slice ${slice.length}`);
        await bumpCounters(runId, { identifiesProcessed: slice.length });
      }
    }
  }

  // ---- 5. customers bulk op (authoritative identify) ----
  // No date filter — fetch ALL customers so returning customers (created before
  // the outage window) get their authoritative total_spent/orders_count corrected.
  const customersBulkId = await startBulkOp(
    admin,
    buildCustomersBulkQuery(""),
  );
  await recordCustomersBulkOp(runId, customersBulkId);
  const customersUrl = await waitForBulkOp(admin, customersBulkId);

  let customerCount = 0;
  let customerLine = 0;
  for await (const { line, node } of streamJsonl(customersUrl)) {
    customerLine = line;
    const id = (node.id as string) ?? "";
    if (!id.startsWith("gid://shopify/Customer/")) continue;
    const customer: ShopifyCustomerPayload = toRestCustomer(node as unknown as GqlCustomerNode);
    const distinctId = resolveCustomerDistinctId(customer);
    if (!distinctId) continue;
    if (isAnonymous) continue; // honour data collection strategy

    const { $set, $set_once } = buildCustomerIdentifyProperties(customer);
    if (!dryRun) {
      await identifyPostHog(
        phConfig,
        distinctId,
        $set,
        $set_once,
        customer.updated_at,
        { historical: true },
      );
    }
    customerCount++;
    if (customerCount % FLUSH_BATCH_SIZE === 0) {
      await bumpCounters(
        runId,
        { identifiesProcessed: FLUSH_BATCH_SIZE },
        undefined,
        customerLine,
      );
    }
  }
  await bumpCounters(
    runId,
    { identifiesProcessed: customerCount % FLUSH_BATCH_SIZE },
    undefined,
    customerLine,
  );

  console.log(`[backfill] run ${runId} complete. skippedWebOrders=${totalSkippedWeb} skippedNoIdentity=${totalSkippedNoId}`);

  // ---- 6. postflight snapshot (non-blocking) ----
  try {
    const postflightRows = await fetchEventSnapshot(excludeSetCreds);
    await recordSnapshot(runId, "postflight", postflightRows);
  } catch (err) {
    console.warn("[backfill] postflight snapshot failed (continuing):", err);
    await recordSnapshot(runId, "postflight", { error: String(err) });
  }

  await setStatus(runId, "completed");
}

# Shopify → PostHog historical backfill

## Context

- `pixiehog-app` (Remix Shopify app) went live with server-side webhook capture on **2026-04-14**. Listens on `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `customers/update` and POSTs to PostHog `/batch/` with `$lib = nuances-server`.
- Web pixel (`$lib = pixiehog`) covers Online Store only. Earliest event 2026-01-28.
- Pre-2026-04-14: subscriptions / POS / draft / Shop channel = 0 in PostHog.
- Pre-2026-01-28: nothing.
- Verified gap (last 30 days, Shopify-side): 1827 orders. PostHog: 1326. Mostly subscription window (nuances-server) being partial + 3% web pixel client loss.
- Goal: one-shot backfill → correct person list, full order history, accurate `total_spent` / `orders_count` / `first_order_date` / `last_order_date` for LTV.

## Approach

Two-stage pipeline inside `pixiehog-app`:

1. **Phase 0 — preflight UUID hardening** (mandatory before any backfill run): patch live webhooks to emit deterministic UUIDs for ALL orders, including non-web. Without this, every backfill row for a non-web order captured since 2026-04-14 will duplicate the live event (live event currently has random server-side UUID; backfill will have a v5 UUID; PostHog's UUID-based dedup compares strings → no match → 2 rows).
2. **Phase 1 — backfill engine**: admin route fires Shopify Admin GraphQL bulk operations, normalises GraphQL → REST shape, reuses existing mappers/identity/dedup, POSTs to `/batch/` with `historical_migration: true`. Includes an exclude-set query so events already in PostHog are skipped at source.

Same code path as live capture → schema parity. Same v5 UUID scheme + exclude-set → no duplicates.

## Phase 0 — preflight (deploy + wait, before backfill)

### 0a. Add fallback UUID for orders without `checkout_token`

`app/common.server/posthog/dedup.ts` — add:

```ts
export function generateOrderEventUUID(
  shop: string,
  checkoutToken: string | null | undefined,
  orderId: number | string,
  eventName: string,
): string {
  const seed = checkoutToken
    ? `${shop}:${checkoutToken}:${eventName}`
    : `${shop}:order_${orderId}:${eventName}`;
  return uuidv5(seed, PIXIEHOG_NAMESPACE);
}

export function generateRefundUUID(shop: string, refundId: number | string) {
  return uuidv5(`${shop}:refund_${refundId}:Order Refunded`, PIXIEHOG_NAMESPACE);
}
```

Also keep existing `generateCheckoutEventUUID` for web-pixel parity.

### 0b. Patch live webhooks to use it

- `app/routes/webhooks.orders.create.tsx:35-37` — replace `order.checkout_token ? generateCheckoutEventUUID(...) : undefined` with `generateOrderEventUUID(shop, order.checkout_token, order.id, "Order Completed")`.
- `app/routes/webhooks.orders.cancelled.tsx` — `generateOrderEventUUID(shop, order.checkout_token, order.id, "Order Cancelled")`.
- `app/routes/webhooks.refunds.create.tsx` — set `uuid: generateRefundUUID(shop, refund.id)`.
- `app/routes/webhooks.orders.updated.tsx` — already uses stable v5 (`updated_at` based). No change.

### 0c. Verify `checkout_token` parity web pixel ↔ webhook

Web pixel (`extensions/web-pixel/src/posthog-ecommerce-spec/events/order_completed.ts:156`) reads `checkout.token` from Web Pixels API. Webhook reads `order.checkout_token` from REST payload. Run on staging shop:

```sql
SELECT properties.order_id, properties.checkout_id, properties.$lib
FROM events
WHERE event='Order Completed' AND properties.order_id != ''
ORDER BY timestamp DESC LIMIT 50
```

Confirm `checkout_id` strings match across libs for same `order_id`. If they diverge (gid prefix, encoding), abort and reconcile token format before backfill.

### 0d. PostHog dedup smoke test

Send same event twice with identical `uuid`, both with `historical_migration: true`. Wait 5 min. Query:

```sql
SELECT count() FROM events WHERE uuid = '<test-uuid>'
```

Must equal 1. Confirms `historical_migration` route still honours UUID dedup. If not, abort plan — need different mitigation (e.g., pre-delete by uuid via PostHog API).

### 0e. Wait window

Deploy 0a/0b. Wait minimum 24 h. Any non-web order captured in this window now has stable v5 UUID. Earlier captured non-web events (2026-04-14 → deploy) still have random server UUIDs and remain the dupe risk → handled by exclude-set in Phase 1.

## Phase 1 — backfill engine

### Files to add

- `app/routes/app.backfill/route.tsx` — admin UI: date range picker (default all-time), dry-run toggle, "Run" button, progress log streamed from server, summary counts.
- `app/routes/api.backfill.tsx` — POST action: creates `BackfillRun`, runs orchestrator.
- `app/common.server/backfill/orchestrator.ts` — sequencing: preflight-snapshot → exclude-set → orders bulk → customers bulk → final-identify pass.
- `app/common.server/backfill/bulk-op.ts` — wraps `bulkOperationRunQuery`, polls `currentBulkOperation`, downloads JSONL, streams via Node `readline` over fetch body.
- `app/common.server/backfill/queries.ts` — GraphQL bulk strings (orders w/ `lineItems`, `refunds`, `customer`, addresses, presentmentMoney, sourceName, financialStatus, fulfillmentStatus, tags, referringSite, landingSite, presentmentCurrencyCode, cancelledAt, cancelReason; customers connection).
- `app/common.server/backfill/normalize.ts` — pure projection from GraphQL nodes into REST-shape interfaces already used by mappers (`ShopifyOrderPayload`, `ShopifyCustomerPayload`, `ShopifyRefundPayload`). Critical mappings:
  - `legacyResourceId` → `id`
  - `processedAt ?? createdAt` → `created_at`
  - `totalPriceSet.presentmentMoney.amount` → `total_price` (presentment, not shop money — matches REST webhook field convention)
  - `subtotalPriceSet.presentmentMoney.amount` → `subtotal_price`
  - `totalTaxSet.presentmentMoney.amount` → `total_tax`
  - `totalShippingPriceSet.presentmentMoney.amount` → `total_shipping_price_set.shop_money.amount` (mapper reads this nested path)
  - `presentmentCurrencyCode` → `currency`
- `app/common.server/backfill/exclude-set.ts` — pre-fetch already-captured order_ids from PostHog so we never re-emit. Uses `/api/projects/:id/query/` with HogQL:
  ```sql
  SELECT properties.order_id, properties.$lib
  FROM events
  WHERE event = 'Order Completed' AND properties.order_id != ''
  ```
  Build `Set<string>` keyed `${order_id}:${lib}`. Skip an `Order Completed` emit if `${id}:nuances-server` already present (live webhook covered it). Web pixel events (`pixiehog`) do not block emit because backfill `$lib` is `nuances-server` → no collision; UUID dedup handles same-order overlap when `checkout_token` matches.
- `app/common.server/backfill/state.ts` — Prisma helpers around new `BackfillRun`.
- `prisma/schema.prisma` + migration:
  ```prisma
  model BackfillRun {
    id                     String    @id @default(cuid())
    shop                   String
    since                  DateTime?
    until                  DateTime?
    dryRun                 Boolean   @default(false)
    bulkOperationIdOrders  String?
    bulkOperationIdCustomers String?
    jsonlOffsetOrders      Int       @default(0)
    jsonlOffsetCustomers   Int       @default(0)
    ordersProcessed        Int       @default(0)
    refundsProcessed       Int       @default(0)
    cancellationsProcessed Int       @default(0)
    identifiesProcessed    Int       @default(0)
    excludedAlreadyCaptured Int      @default(0)
    preflightSnapshot      Json?
    postflightSnapshot     Json?
    status                 String    @default("pending")
    error                  String?
    startedAt              DateTime  @default(now())
    finishedAt             DateTime?
  }
  ```

### Files to reuse (no logic change)

- `app/common.server/posthog/posthog-capture.ts` — `capturePostHogEvents`, `identifyPostHog`. Add optional flag `{ historical?: boolean }`; when true, append `historical_migration: true` to each event's `properties`. Live webhooks call without flag → zero behaviour change.
- `app/common.server/posthog/mappers/order-completed.ts` — `mapOrderCompleted`. Plus dual-key fix below.
- `app/common.server/posthog/mappers/refund-created.ts` — `mapRefundCreated`.
- `app/common.server/posthog/mappers/order-cancelled.ts` — existing.
- `app/common.server/posthog/identity.ts` — `resolveDistinctId`, `resolveCustomerDistinctId`, `buildIdentifyProperties`, `buildCustomerIdentifyProperties`.

### Two-line drive-by fix (ship inside Phase 0 deploy)

`mappers/order-completed.ts:105` writes `customer_orders_count`. Dashboard tile **"New / Returning Customers Orders (identified only)"** (insights `koi6iCDF` + `hd0r8Gsb` on dashboard 607753) filters on `ordersCount` (camelCase, web pixel name). Server events miss tile. Set both:

```ts
customer_orders_count: order.customer?.orders_count ?? null,
ordersCount: order.customer?.orders_count ?? null,
```

### Orchestrator flow

1. **Preflight snapshot** — HogQL: `count() by month, $lib, source_name`. Persist on `BackfillRun.preflightSnapshot`.
2. **Build exclude-set** — fetch all `(order_id, $lib)` pairs from PostHog (paginate if >1M rows). Persist count.
3. **Orders bulk op** — `bulkOperationRunQuery` for orders. Poll → JSONL URL.
4. **Stream JSONL line-by-line** via `readline`:
   - For each `Order`: normalize → if `${id}:nuances-server` in exclude-set, increment `excludedAlreadyCaptured`, skip Order Completed emit. Else `mapOrderCompleted`, attach dual `ordersCount`/`customer_orders_count`, set `historical_migration: true`, deterministic UUID via `generateOrderEventUUID`, timestamp `processedAt ?? createdAt`. Buffer.
   - If `cancelledAt`: emit `Order Cancelled` with cancel UUID, cancelledAt timestamp.
   - For each child `Refund`: emit `Order Refunded` with refund UUID, refund.createdAt timestamp.
   - In-memory `Map<email, latestOrder>`: track newest order per email.
   - Flush every 100 events → `capturePostHogEvents(..., { historical: true })`. Update `jsonlOffsetOrders` + counters per flush so crash resumes.
5. **Final identify pass** — iterate `Map<email, latestOrder>`, build `buildIdentifyProperties(latestOrder)`, emit one `$identify` per email with `historical_migration: true`. PostHog $set last-write-wins on timestamp; identify timestamp = latest order processedAt → no thrash.
6. **Customers bulk op** — second bulk for `customers` connection. Stream → `buildCustomerIdentifyProperties` → `identifyPostHog` with timestamp = `customer.updatedAt`. Authoritative `total_spent` / `orders_count` lands last (newer timestamp than per-order identifies) → person profile reflects Shopify state of record.
7. **Postflight snapshot** — same query as preflight. Persist diff.
8. `status=completed`, `finishedAt`.

### Idempotent re-run guard

Reject second run for the same shop unless `BackfillRun.status` ∈ {`failed`, `cancelled`} OR caller passes `force: true`. Resumption is detected by presence of `jsonlOffsetOrders > 0` + `status='running'` → orchestrator resumes mid-file.

### PII / consent

`shopConfig.dataCollectionStrategy !== 'non-anonymized'` → skip `$identify` entirely; strip `email`, `first_name`, `last_name`, `phone`, `tags`, `customer_orders_count` from event properties. Mirrors `webhooks.orders.create.tsx`. Backfill respects same setting.

## Verification

1. **Phase 0 dedup smoke** — section 0d above. Must pass before Phase 1.
2. **Checkout token parity** — section 0c. Must pass before Phase 1.
3. **Dry-run** — UI checkbox short-circuits `capturePostHogEvents`; logs first 10 events of each kind as JSON. Eyeball vs Shopify admin order page.
4. **Smoke run** — 2026-04-15 → 2026-04-15 (one day inside live nuances-server window). Expect ~0 net new `Order Completed` because exclude-set covers them. Confirm:
   ```sql
   SELECT count() FROM events WHERE event='Order Completed' AND timestamp >= '2026-04-15' AND timestamp < '2026-04-16'
   ```
   pre vs post.
5. **Cold run** — 2025-12-01 → 2025-12-31. PostHog count must match Shopify Admin "Total orders" for December (within tz boundary rounding).
6. **Full reconciliation** post-run:
   ```sql
   SELECT toStartOfMonth(timestamp) AS m, count(), groupArray(DISTINCT properties.$lib)
   FROM events WHERE event='Order Completed' GROUP BY m ORDER BY m
   ```
   vs Shopify Admin reports → match within ~3% on web months (pixiehog client loss); 100% match on subs/POS/draft months.
7. **Person spot check** — 5 random emails. PostHog person profile `total_spent`, `orders_count`, `first_order_date`, `last_order_date` matches Shopify customer record.
8. **Dupe regression** — must be empty:
   ```sql
   SELECT properties.order_id, count(), groupArray(properties.$lib), groupArray(uuid)
   FROM events
   WHERE event='Order Completed' AND timestamp >= '2026-04-14'
   GROUP BY 1 HAVING count() > 1 LIMIT 50
   ```
9. **Live webhook regression** — post-deploy, place real test order. Confirm exactly 1 `Order Completed` (live pixel; server skips because `source_name='web'`).
10. **Dashboard 607753** — "Identified only" tiles non-zero for nuances-server contributions thanks to dual-key `ordersCount` fix.

## Closed gaps (vs first draft)

| # | Risk | Mitigation in this plan |
|---|------|-------------------------|
| 1 | Non-web orders 2026-04-14 → present have null UUID → backfill dupes them | Phase 0 fallback UUID + exclude-set query in orchestrator skips already-captured `(order_id, nuances-server)` pairs |
| 2 | `historical_migration` route may bypass UUID dedup | Phase 0d smoke test gates the run |
| 3 | Web pixel `checkout.token` ≠ webhook `order.checkout_token` → web orders dupe | Phase 0c parity check gates the run |
| 4 | $identify out-of-order → `last_order_date` regresses | In-memory `Map<email, latestOrder>` emits ONE identify per email at end |
| 5 | Currency split when shop is multi-currency | normalize.ts uses `presentmentMoney.amount` + `presentmentCurrencyCode` |
| 6 | Re-running backfill writes thousands of dupes | Idempotent guard on `BackfillRun.status` + exclude-set rebuilds each run |
| 7 | Refund double-subtract on LTV | Authoritative `total_spent` set last from customers bulk; refund events informational only |
| 8 | PostHog `/batch/` 20 MB cap | Cap 100 events / batch |
| 9 | Shopify bulk op concurrency 1 | Orchestrator runs orders bulk → customers bulk sequentially |
| 10 | Memory blowup on big JSONL | `readline` stream, no full-file buffer |
| 11 | Crashed run loses progress | `BackfillRun.jsonlOffset*` resumes mid-file |

## Open / accepted risks

- **2026-04-14 → Phase 0 deploy window** — live nuances-server events for non-web orders in this window have random UUIDs. Exclude-set blocks backfill from re-emitting them, so net-zero dupes added by backfill — but those events lack the deterministic UUID needed for future re-backfills. Acceptable: don't re-backfill that window.
- **Customers w/o email + no Shopify customer record** — `resolveDistinctId` returns null → event skipped. Matches live webhook behaviour. LTV unaffected (no customer to track).
- **Shopify customer email change** — orders pre-change attach to old email distinct_id, post-change to new. PostHog won't auto-merge. Out of scope; manual `$create_alias` if needed.

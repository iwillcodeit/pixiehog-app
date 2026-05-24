# TODO — PixieHog Backfill & Server-Side Events

## Immediate (before full-history backfill)

### Crash resumption for large backfills
- [ ] On start, check `findResumableRun()` — reuse existing bulk op URL if still valid
- [ ] Pass stored `jsonlOffsetOrders`/`jsonlOffsetCustomers` to `streamJsonl()`
- [ ] Handle URL expiry (7 days) — re-trigger bulk op if stale
- [ ] Handle partial `AssembledOrder` at offset boundary (skip orphaned children until next top-level order)
- [ ] Test: crash mid-stream, resume, verify no duplicates and no gaps
- **Why**: full-history backfill (pre-pixiehog era) could be 10k+ orders, 30+ min. Can't re-run from scratch on every failure.
- **Where**: `app/common.server/backfill/orchestrator.ts` header comment has detailed plan

## Future (multi-shop / scale)

### Exclude-set multi-shop safety
- [ ] Add `properties.affiliation AS shop` to HogQL query in `exclude-set.ts`
- [ ] Key becomes `${orderId}:${lib}:${shop}` (currently `${orderId}:${lib}`)
- [ ] Update `shouldSkipOrderCompleted()` to accept shop param
- **Why**: Shopify order IDs are per-shop integers. Two shops could share ID `1001`. Currently safe because one PostHog token per shop.
- **Where**: `app/common.server/backfill/exclude-set.ts` has TODO comment with exact fix

### Refund line items pagination
- [ ] `refundLineItems(first: 100)` in `queries.ts` truncates large refunds
- [ ] Bump to `first: 250` or handle pagination in normalize assembly
- **Why**: wholesale/bulk return shops could exceed 100 line items per refund
- **Risk**: low for Lightinderm (skincare, max ~10 items/order)

### `identifyPostHog` return value
- [ ] Change `identifyPostHog` to return `Promise<boolean>` (propagate capture result)
- [ ] Check return in customer bulk op loop
- **Why**: failed identifies currently counted as processed

### Cancellation UUID alignment (required before full-history backfill)
- [ ] Change live webhook `webhooks.orders.cancelled.tsx` to always use `order_${id}` seed (drop checkout_token from cancellation UUID)
- [ ] Or: add `checkoutToken` field to GraphQL bulk query in `queries.ts` (if Shopify exposes it)
- **Why**: backfill always uses `order_${id}` seed (bulk API doesn't return checkout_token). Live webhook uses checkout_token when present. Different seeds → different UUIDs → duplicates on full-history backfill where live events already exist.
- **Why safe for May 2026 recovery**: non-web orders don't have checkout_token (seeds match), web orders skipped, server was down (no live events to conflict).
- **Recommendation**: option A (always order_id for cancellations) — there's no pixel-side cancellation event to dedup against, so checkout_token seed adds no value.

### Anonymized mode `distinct_id` uses email
- [ ] In anonymized mode, resolve `distinct_id` via `shopify_customer_{id}` only (skip email chain)
- [ ] Applies to both live webhooks and backfill orchestrator
- **Why**: `stripPii()` removes email from properties but `distinct_id` is still the email → PostHog stores it as person identifier. Defeats anonymization purpose.
- **Why safe for Lightinderm**: shop is non-anonymized (`dataCollectionStrategy === "non-anonymized"`). Code path never executes.
- **When to fix**: if PixieHog ever serves shops that require GDPR-level anonymization.

### Personal API key sent to shop-configured host (multi-tenant security)
- [ ] HogQL queries in `exclude-set.ts` and `orchestrator.ts` (`fetchEventSnapshot`) send `Authorization: Bearer <personalApiKey>` to `shopRow.posthogApiHost`
- [ ] A malicious shop owner could set `posthogApiHost` to an attacker URL → operator's key exfiltrated
- [ ] Fix: use a hardcoded/env-var PostHog host for HogQL queries, or validate against a trusted domain allowlist
- **Why safe for Lightinderm**: single-shop fork, we control `posthogApiHost` ourselves. No multi-tenant scenario.
- **When to fix**: before PixieHog becomes a multi-tenant app serving untrusted shops.

### `currentBulkOperation` deprecation
- [ ] Migrate from `currentBulkOperation` to `bulkOperations(first: 1)` query
- **Why**: Shopify deprecated the field (still functional, removal date unknown)
- **Where**: `app/common.server/backfill/bulk-op.ts`

## Done ✅

- [x] Web order filter (`source_name === "web"`) on Order Completed
- [x] Retry logic (3x backoff) + 15s timeout for backfill batches
- [x] `historical_migration` at top-level `/batch/` body
- [x] HogQL LIMIT 500k + fail-fast on truncation
- [x] `backfilled: "YYYY-MM-DD"` tag on all events
- [x] 120ms flush throttle (stays under 10 req/s)
- [x] Failed batch throws (aborts run)
- [x] Failed batch counters not inflated
- [x] Identity warning + `skippedNoIdentity` counter
- [x] `lineItems(first: 250)` pagination arg
- [x] Refunds emit for ALL orders (not just non-web)
- [x] Customer bulk op fetches ALL customers (no date filter)
- [x] Subscription detection on server path (`has_subscription`, `selling_plan_name`)
- [x] TypeScript `Promise<unknown>[]` fix
- [x] Date validation in API endpoint
- [x] Preflight/postflight HogQL snapshots (non-blocking)
- [x] UI auto-polling + status-based progress indicator
- [x] Confirmation dialog before live backfill

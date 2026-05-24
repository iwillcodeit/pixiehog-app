# Recovery Plan: Missing PostHog Server-Side Events (May 5-23, 2026)

## Context

Railway Postgres addon crashed, causing PixieHog webhook handlers to silently fail for **19 days** (May 5-23). Zero `nuances-server` events reached PostHog. Web pixel events (`pixiehog`) unaffected. App now running from old April 27 deployment. Postgres restored.

**Missing events**: Order Completed (non-web), Order Cancelled, Order Refunded, $identify
**NOT backfilling**: Order Updated (user decision — lower value)

Branch `feat/posthog-backfill` contains all changes. Adversarial-reviewed and hardened.

---

## Step 1: Fix WIP Code Before Committing

All paths relative to repo root.

### CRITICAL FIXES — all implemented ✅

| Fix | File | Status |
|-----|------|--------|
| **1a. Web order filter** | `orchestrator.ts` | ✅ `source_name === "web"` check + `skippedWebOrders` counter |
| **1b. Retry + throttle** | `posthog-capture.ts` | ✅ 3 retries w/ backoff for backfill, 15s timeout, returns `boolean` |
| **1c. HogQL LIMIT** | `exclude-set.ts` | ✅ `LIMIT 500000` + truncation warning |
| **1d. Identity warning** | `orchestrator.ts` | ✅ Counter + `console.warn` for null distinct_id |
| **1e. Date validation** | `api.backfill.tsx` | ✅ `isNaN(date.getTime())` guard |
| **1i. `backfilled` tag** | `orchestrator.ts` | ✅ Every event gets `backfilled: "YYYY-MM-DD"` |
| **Flush throttle** | `orchestrator.ts` + `throttle.ts` | ✅ 120ms between PostHog batches (stays under 10 req/s) |
| **Summary log** | `orchestrator.ts` | ✅ Cumulative `skippedWebOrders` + `skippedNoIdentity` at run end |

### REMAINING (should fix, lower risk)

### 1f. Preflight/postflight snapshot stubs
**File**: `app/common.server/backfill/orchestrator.ts` (lines ~139, ~350)
Replace `{ todo: "..." }` with actual HogQL count query. Reuse `fetchExcludeSet` pattern.

### 1g. Add `order_number` to normalizer
**File**: `app/common.server/backfill/normalize.ts` in `toRestOrder()`
Extract numeric order number from GraphQL `name` field: `parseInt(name.replace(/\D/g, ""), 10) || null`

### 1h. UI auto-polling + progress bar fix
**File**: `app/routes/app.backfill.tsx`
Add `useRevalidator()` + `useEffect` interval (5s). Replace hardcoded progress bar.

### DEFERRED (post-backfill improvements)
- Exclude-set coverage for Order Cancelled/Refunded (low volume, low risk)
- Customer email-change alias handling (pre-existing design gap)
- Refund identity resolution fallback to `shopify_customer_{id}`

---

## Step 2: Commit in Two Parts

### Commit 1: Phase 0 — UUID hardening for live webhooks
```
git add app/common.server/posthog/dedup.ts \
       app/common.server/posthog/mappers/order-completed.ts \
       app/common.server/posthog/posthog-capture.ts \
       app/routes/webhooks.orders.create.tsx \
       app/routes/webhooks.orders.cancelled.tsx \
       app/routes/webhooks.refunds.create.tsx \
       extensions/web-pixel/src/posthog-ecommerce-spec/events/checkout-started.ts \
       extensions/web-pixel/src/posthog-ecommerce-spec/events/order_completed.ts
```
Message: `feat: deterministic UUID for all order events + subscription detection`

### Commit 2: Phase 1 — backfill engine + schema
```
git add prisma/schema.prisma \
       app/common.server/backfill/ \
       app/routes/api.backfill.tsx \
       app/routes/app.backfill.tsx
```
Message: `feat: historical backfill engine for Shopify→PostHog event recovery`

Note: Prisma migration file at `prisma/migrations/20260428000000_add_backfill_run/` — verify it exists in untracked files, add it too.

---

## Step 3: Merge & Deploy

1. Push `feat/posthog-backfill` to remote
2. Create PR → merge to `main`
3. User fixes Railway build config (Nixpacks → Dockerfile) manually
4. Railway auto-deploys from `main`
5. Verify in Railway logs:
   - `prisma migrate deploy` succeeds (BackfillRun table created)
   - App starts without errors
   - No `P1001: Can't reach database` errors

---

## Step 4: Phase 0 Smoke Tests (Before Backfill)

### 4a. PostHog UUID dedup test
Send same test event twice with identical UUID + `historical_migration: true`. Wait 5 min. Query:
```sql
SELECT count() FROM events
WHERE event = '__backfill_dedup_test'
```
Must return **1**.

### 4b. Exclude-set connectivity test
Verify HogQL query endpoint works with personal API key against project 103976.

### 4c. No 24h wait needed
Server was down May 5-23 — no conflicting `nuances-server` events exist in that window. Any events from the transition window (May 23 → deploy) are handled by the exclude-set. Wait 1-2 hours max after deploy for webhook retries to settle.

---

## Step 5: Backfill Execution

### 5a. Dry run
Navigate to Shopify Admin → PixieHog app → `/app/backfill`

Parameters:
- **Since**: `2026-05-05T00:00:00.000Z`
- **Until**: `2026-05-24T00:00:00.000Z`
- **Dry run**: ON
- **PostHog personal API key**: `phx_...`
- **PostHog project ID**: `103976`

Verify in Railway logs:
- `[backfill] dryRun flush` lines show reasonable events
- `ordersProcessed` should be MUCH LESS than total Shopify orders (web orders filtered out)
- `excludedAlreadyCaptured` ≈ 0 (server was down, almost nothing to exclude)
- `skippedNoIdentity` should be 0 or near-0 (all server orders should have email)
- Event payloads have valid `distinct_id` (email), `order_id`, `total`, `uuid`, `timestamp`
- **NO events with `source_name: "web"`** in the dry-run output — confirms web filter works
- Exclude-set `totalRowsFetched` logged — confirm it's a reasonable number (not a round pagination boundary like 10000)

### 5b. Cross-reference with Shopify
Check Shopify Admin order count for May 5-23. Dry run total should approximate this minus web orders.

### 5c. Real run
Same params, **Dry run: OFF**. Expected duration: 5-20 minutes for ~400-600 orders.

---

## Step 6: Post-Backfill Verification

### 6a. Gap filled check (PostHog HogQL)
```sql
SELECT toDate(timestamp) AS day, properties.$lib AS lib, count()
FROM events
WHERE event = 'Order Completed'
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-24'
GROUP BY day, lib ORDER BY day
```
Every day should now show `nuances-server` events.

### 6b. Duplicate detection (CRITICAL — run IMMEDIATELY after backfill, before celebrating)
```sql
SELECT properties.order_id, count() AS cnt,
  groupArray(properties.$lib) AS libs, groupArray(uuid) AS uuids
FROM events
WHERE event = 'Order Completed'
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-24'
GROUP BY properties.order_id HAVING cnt > 1 LIMIT 50
```
Must return **0 rows**. If any rows show `libs = ['pixiehog', 'nuances-server']`, the web order filter (1a) failed — web orders leaked into the backfill.

### 6c. Broader dupe check
```sql
SELECT properties.order_id, count(), groupArray(properties.$lib)
FROM events
WHERE event = 'Order Completed' AND timestamp >= '2026-04-14'
GROUP BY properties.order_id HAVING count() > 2 LIMIT 50
```

### 6d. Person spot check
Pick 5 emails → verify `orders_count`, `total_spent`, `last_order_date` match Shopify customer records.

### 6e. Preflight vs postflight snapshot
Compare `BackfillRun.preflightSnapshot` vs `postflightSnapshot` — should show increase in `nuances-server` event counts for May 2026.

---

## Rollback

PostHog has no bulk-delete API. If bad data sent:
1. Small scope → filter/exclude in dashboards
2. Large scope → contact PostHog support for ClickHouse-level deletion
3. Partial failure → re-run; exclude-set skips already-sent events; UUID dedup prevents exact duplicates

---

## Key Files

| File | Role |
|------|------|
| `app/common.server/backfill/orchestrator.ts` | Main pipeline (7 steps) |
| `app/common.server/backfill/exclude-set.ts` | Dedup safety net |
| `app/common.server/backfill/normalize.ts` | GraphQL→REST projection |
| `app/common.server/backfill/bulk-op.ts` | Shopify bulk ops wrapper |
| `app/common.server/backfill/queries.ts` | GraphQL query builders |
| `app/common.server/backfill/state.ts` | BackfillRun DB helpers |
| `app/common.server/posthog/dedup.ts` | UUID generation (Phase 0) |
| `app/common.server/posthog/posthog-capture.ts` | PostHog batch API + historical flag |
| `app/routes/api.backfill.tsx` | POST endpoint |
| `app/routes/app.backfill.tsx` | Admin UI |
| `plans/shopify-posthog-backfill.md` | Canonical reference doc |

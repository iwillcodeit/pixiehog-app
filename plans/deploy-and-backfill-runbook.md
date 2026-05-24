# Deploy & Backfill Runbook — May 2026 Recovery

## Prerequisites

- [x] PR #14 merged to main
- [x] Safety branch `save-main-24-05-26` pushed
- [ ] Railway build config fixed (Nixpacks → Dockerfile)

---

## Step 1: Railway Deploy

### 1a. Trigger deploy
- If Railway auto-deploys from GitHub: should already be building after push to main
- If not: go to Railway dashboard → pixiehog-app service → "Deploy" or trigger manual redeploy from latest main commit

### 1b. Verify build succeeds
Check Railway build logs for:
- `FROM node:20-slim` (NOT `node:18-alpine` — confirms Dockerfile used, not Nixpacks)
- `pnpm install --frozen-lockfile` succeeds
- `pnpm prisma generate` succeeds
- `pnpm run build` succeeds

### 1c. Verify runtime startup
Check Railway deploy logs for:
```
prisma migrate deploy
```
Must show:
- Migration `20260428000000_add_backfill_run` applied (creates `BackfillRun` table)
- No `P1001: Can't reach database` errors
- App listening / ready

### 1d. Verify webhooks flowing
Wait 2-3 minutes, check logs for:
```
POST /webhooks/orders/create 200
POST /webhooks/customers/update 200
```
Any webhook returning 200 = app is alive and connected to Postgres.

---

## Step 2: Shopify App Deploy

### 2a. Deploy web pixel extension
```bash
cd pixiehog-app
shopify app deploy
```
This publishes the updated web pixel with `has_subscription` + `selling_plan_name` properties.

### 2b. Verify web pixel updated
- Place a test order (or wait for organic traffic)
- PostHog → Live Events → filter `$lib = pixiehog`
- Check an `Order Completed` or `Checkout Started` event has `has_subscription` property

---

## Step 3: Wait & Verify Phase 0 (1 hour)

### 3a. Why wait
- Shopify may retry webhooks from the last few hours
- New deterministic UUIDs need to be live before backfill runs
- Exclude-set needs current data to work correctly

### 3b. Verify Phase 0 live events
Check PostHog (Live Events or HogQL):
```sql
SELECT timestamp, event, properties.$lib, properties.order_id, uuid
FROM events
WHERE properties.$lib = 'nuances-server'
ORDER BY timestamp DESC
LIMIT 10
```
If any non-web orders come in during this hour, they should now have deterministic UUIDs (v5 format, not random).

### 3c. Optional: UUID dedup smoke test
Send same test event twice with identical UUID:
```bash
TEST_UUID="11111111-2222-3333-4444-555555555555"
for i in 1 2; do
  curl -s -X POST https://us.i.posthog.com/batch/ \
    -H "Content-Type: application/json" \
    -d '{
      "api_key": "<PROJECT_API_KEY>",
      "historical_migration": true,
      "batch": [{
        "event": "__backfill_dedup_test",
        "properties": { "distinct_id": "dedup-test@test.com", "$lib": "nuances-server", "run": '$i' },
        "uuid": "'$TEST_UUID'"
      }]
    }'
done
```
Wait 5 min, then check:
```sql
SELECT count() FROM events WHERE event = '__backfill_dedup_test'
```
Must return **1** (not 2). Confirms `historical_migration` + UUID dedup works.

---

## Step 4: Dry-Run Backfill

### 4a. Navigate to backfill UI
Shopify Admin → Apps → PixieHog → `/app/backfill`

### 4b. Fill parameters
| Field | Value |
|-------|-------|
| Since | `2026-05-05T00:00:00.000Z` |
| Until | `2026-05-25T00:00:00.000Z` |
| Dry run | ✅ ON (default) |
| PostHog personal API key | `phx_...` (your personal key from PostHog settings) |
| PostHog project ID | `103976` |

### 4c. Click "Run backfill"

### 4d. Monitor Railway logs
Watch for:
```
[backfill] exclude-set fetched N rows       ← should be a reasonable number
[backfill] dryRun flush 100 events [...]    ← event payloads logged (first 3)
[backfill] run <id> complete. skippedWebOrders=X skippedNoIdentity=Y
```

### 4e. Verify dry-run results

**Expected values:**
- `skippedWebOrders` > 0 (web orders filtered correctly)
- `skippedNoIdentity` = 0 or near-0 (all server orders should have email)
- `ordersProcessed` should be MUCH LESS than total Shopify orders in the window (web orders excluded)
- NO events with `source_name: "web"` in logged payloads

**Cross-reference with Shopify:**
- Shopify Admin → Orders → filter May 5-24
- Total orders minus web orders ≈ `ordersProcessed`

### 4f. Sanity check logged events
In the dry-run log output, check the first 3 events:
- `distinct_id` is an email (not null, not `shopify_customer_...`)
- `order_id` is a numeric string
- `total` is a reasonable amount
- `uuid` is a deterministic UUID string
- `timestamp` falls within May 5-24
- `backfilled` property is present (today's date)

---

## Step 5: Real Backfill

### 5a. Same parameters, dry run OFF
| Field | Value |
|-------|-------|
| Since | `2026-05-05T00:00:00.000Z` |
| Until | `2026-05-25T00:00:00.000Z` |
| Dry run | ❌ OFF (uncheck) |
| PostHog personal API key | same `phx_...` |
| PostHog project ID | `103976` |

### 5b. Confirmation dialog
Browser will prompt: "LIVE BACKFILL: This will write real data to PostHog and cannot be undone. Continue?"
→ Confirm

### 5c. Monitor progress
- UI auto-polls every 5s showing counters
- Railway logs show `[backfill]` flush lines
- Expected duration: 5-20 minutes

### 5d. Watch for errors
- `[backfill] flush failed` → run will abort (throws). Check PostHog status.
- `[backfill] identify flush failed` → identifies not counted. Non-fatal but noted.
- `[nuances-server] PostHog returned 429` → rate limited, retry kicks in automatically

### 5e. Run completes
Log shows:
```
[backfill] run <id> complete. skippedWebOrders=X skippedNoIdentity=Y
```
UI shows status: "Completed" with final counters.

---

## Step 6: PostHog Verification (CRITICAL)

Run these immediately after backfill completes. Can be done via PostHog MCP or PostHog UI → SQL.

### 6a. Gap filled check
```sql
SELECT toDate(timestamp) AS day, properties.$lib AS lib, count()
FROM events
WHERE event = 'Order Completed'
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-25'
GROUP BY day, lib
ORDER BY day
```
Every day should now show `nuances-server` events alongside `pixiehog`.

### 6b. Duplicate detection (MOST IMPORTANT)
```sql
SELECT
  properties.order_id,
  count() AS cnt,
  groupArray(properties.$lib) AS libs,
  groupArray(uuid) AS uuids
FROM events
WHERE event = 'Order Completed'
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-25'
GROUP BY properties.order_id
HAVING cnt > 1
LIMIT 50
```
**Must return 0 rows.** If any rows show `libs = ['pixiehog', 'nuances-server']` → web order filter failed.

### 6c. Broader dupe check (full history since server went live)
```sql
SELECT properties.order_id, count(), groupArray(properties.$lib)
FROM events
WHERE event = 'Order Completed' AND timestamp >= '2026-04-14'
GROUP BY properties.order_id
HAVING count() > 2
LIMIT 50
```
Should return 0 rows. An order can appear at most once per `$lib`.

### 6d. Backfilled events tag check
```sql
SELECT count(), properties.backfilled
FROM events
WHERE properties.backfilled != ''
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-25'
GROUP BY properties.backfilled
```
Should show all backfilled events tagged with today's date.

### 6e. Cancellation + refund check
```sql
SELECT event, count()
FROM events
WHERE event IN ('Order Cancelled', 'Order Refunded')
  AND timestamp >= '2026-05-05' AND timestamp < '2026-05-25'
  AND properties.$lib = 'nuances-server'
GROUP BY event
```
Compare counts with Shopify admin cancellations/refunds in that window.

### 6f. Person spot check (5 customers)
Pick 5 customer emails from the backfill window:
1. PostHog → Persons → search by email
2. Verify: `orders_count`, `total_spent`, `last_order_date` match Shopify customer record
3. Check `first_order_date` is correct (via `$set_once`)

### 6g. Preflight vs postflight snapshot
If you have DB access (Railway Postgres):
```sql
SELECT "preflightSnapshot", "postflightSnapshot"
FROM "BackfillRun"
ORDER BY "startedAt" DESC
LIMIT 1;
```
Compare: postflight should show increased `nuances-server` counts for May 2026.

---

## Step 7: Close the Loop

### 7a. PostHog annotation
Add annotation in PostHog at May 24 2026:
"Backfill: recovered nuances-server events for May 5-24 outage (Railway Postgres crash)"

### 7b. Update plan docs
Mark backfill-recovery-may2026.md verification steps as done with results.

### 7c. Monitor next 24h
Check PostHog trends for `Order Completed` by `$lib`:
- `nuances-server` should show continuous events from May 5 onward (no more gap)
- `pixiehog` should be unaffected (continuous as before)

### 7d. Clean up test event (if smoke test was run)
```sql
-- Verify test event exists, then note its UUID for manual deletion request if needed
SELECT * FROM events WHERE event = '__backfill_dedup_test'
```

---

## Rollback

If something went wrong:

**Bad data sent to PostHog:**
- PostHog has no bulk-delete API
- Small scope → filter out in dashboards using `backfilled` property
- Large scope → contact PostHog support for ClickHouse-level deletion
- All backfilled events are tagged `backfilled: "YYYY-MM-DD"` for easy identification

**App broken after deploy:**
- Railway: redeploy from `save-main-24-05-26` branch
- Or: `git revert` the merge commit and push to main

**Backfill run failed midway:**
- Events already sent are in PostHog (UUID dedup protects against re-send)
- Re-run the backfill with same params — exclude-set skips already-captured orders
- Failed run status visible in `/app/backfill` UI

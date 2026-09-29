# nuances-posthog (PixieHog fork)

## web-pixel 1.1.0 — 2026-09-29

Attribution fix. `$lib_version` is `1.1.0` on every event sent by this build.

- **Campaign params use PostHog's plain key names** — `utm_source`, `utm_medium`, `gclid`, `fbclid`, `_kx`, … instead of `$utm_source` etc. PostHog's sessions table, channel-type classification and person-property lift read the plain keys; the `$`-prefixed ones were read by nothing, so every pixel-first session lost `$entry_utm_*` / `$channel_type`. First-touch keys stay `$initial_<param>`. Breaking for anything built on `$utm_*` (nothing in our project).
- **No nulls in `$set_once`** — missing campaign params and unknown device fields (`$initial_device_type` on desktop) are omitted instead of sent as `null`. PostHog stores an explicit `$set_once` null and never overwrites it, so a UTM-less first visit locked `$initial_utm_*` to null forever. First touch now means "first non-empty campaign seen", which is also how PostHog's own server-side lift behaves (it refuses to write nulls into `$set_once`). Existing null-locked persons are not repaired.
- **Campaign params are computed per event** from the event's own URL (the checkout SPA can navigate without re-running the pixel); DOM events fall back to the boot-time snapshot.
- **Anonymous (consent-refused) visitors never receive `$set` / `$set_once`** on any event, and the logged-in customer's fields (`email`, `phone`, …) are no longer flattened into top-level event properties either. Previously only `page_viewed` was protected via `$process_person_profile: false`; other events pushed the customer's fields into person profiles, and every event carried them as properties. Identified visitors keep the flattened fields (PostHog New-vs-Returning insights filter on `ordersCount`).
- **Consent is evaluated per event**, not once at boot: withdrawing consent mid-page (`visitorConsentCollected`) now anonymises every subsequent event and triggers the identity reset, instead of only taking effect on the next page load. Granting consent mid-page identifies the logged-in customer before the next event, so their events do not land on the anonymous id.
- **`$set` is limited to customer fields**, with nulls stripped (an absent `phone` / `lastName` no longer clobbers an existing person property). Browser / URL / UTM person properties are lifted by PostHog ingestion from event properties on every event, which is fresher than the previous boot-time snapshot.
- The pixel now merges into the shared posthog-js localStorage blob when writing `distinct_id` instead of replacing it (kept: `$sesid`, `$initial_person_info`, …). The full wipe on consent withdrawal (`resetPosthog`) is unchanged and intentional.
- **Identity reset no longer depends on the consent marker alone.** Before sending anything — at boot (before the distinct_id is resolved and feature flags are preloaded) and before every event — an anonymous visitor whose shared posthog-js blob still holds an identified `distinct_id` (email set by the pixel, customer id set by the theme's `posthog.identify`) gets the full reset. Previously it only fired on the `'false' → 'true'` marker flip, so a fresh sandbox (marker absent) or a marker already at `'true'` sent anonymous events under the persisted identity. UUID ids are the normal anonymous state and never trigger a reset (that would drop the theme's `$sesid` / `$device_id` on every event).
- **`$process_person_profile: false` on every anonymous event**, not only `page_viewed`. PostHog ingestion lifts plain event properties (`utm_*`, `gclid`, `$browser`, …) into a person profile even without `$set`; anonymous events now create no person at all.
- **No typed values in DOM events when anonymous**: `input_*` / `clicked` drop `element.value`, `form_submitted` drops `form_body` and every field's `value`. Field names, types and ids are kept.
- **`$current_url` / `$pathname` / `$host` follow the event URL**, like campaign params already did; they were pinned to the boot URL across checkout SPA navigation. DOM events keep the boot values.
- **New `is_first_order` property on `Order Completed`** (web pixel): Shopify's `checkout.order.customer.isFirstOrder` surfaced top-level (it was only reachable nested under `order.customer`, invisible to PostHog filters/cohorts/experiment metrics), `null` when Shopify does not provide it.
- Tooling: vitest test harness (`pnpm test`), 40 unit tests on `campaign-params.ts` / `event-properties.ts` / `consent-state.ts` / ecommerce-spec and server `Order Completed` mappers.

## server app — 2026-09-29

- **`is_first_order` on the webhook-driven `Order Completed`** (`app/common.server/posthog/mappers/order-completed.ts`), same key as the web pixel: `false` for subscription renewals (`subscription_contract_checkout_one`, never a first order), `null` (unknown) for every other server-side channel — Shopify no longer sends `customer.orders_count` in order webhooks.

---

# @shopify/shopify-app-template-remix

## 2024.09.18

- [850](https://github.com/Shopify/shopify-app-template-remix/pull/850) Removed "~" import alias

## 2024.09.17

- [842](https://github.com/Shopify/shopify-app-template-remix/pull/842)Move webhook processing to individual routes

## 2024.08.19

Replaced deprecated `productVariantUpdate` with `productVariantsBulkUpdate`

## v2024.08.06

Allow `SHOP_REDACT` webhook to process without admin context

## v2024.07.16

Started tracking changes and releases using calver

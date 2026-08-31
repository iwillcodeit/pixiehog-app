import { calculateCampaignParams, type CampaignParams } from './campaign-params';

/**
 * Drop `null` / `undefined` values from a flat object.
 *
 * Needed for `$set_once`: PostHog stores an explicit `null` and `$set_once` never overwrites, so a null
 * `$initial_utm_source` sent on a UTM-less visit would block the real first-touch value forever.
 */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== null && value !== undefined)
  ) as Partial<T>;
}

export type BuildEventPropertiesArgs = {
  /** Boot-time properties shared by every event (browser, screen, referrer, shop, customer, cart, …). */
  base: Record<string, unknown>;
  /** `init.data.customer` — becomes `$set` for identified (non-anonymous) visitors. */
  customer: Record<string, unknown> | null | undefined;
  /** Campaign params computed from the boot-time URL. */
  initCampaign: CampaignParams;
  /** The event's own URL (`event.context.document.location.href`); `undefined` for DOM events, which carry no document context. */
  eventHref: string | undefined;
  /** Consent-derived flag: when `true`, no person properties (`$set` / `$set_once`) are ever sent. */
  anonymous: boolean;
  /** Boot-time `$initial_*` device/referrer properties for `$set_once`. */
  setOnceBase: Record<string, unknown>;
};

/**
 * Build the property bag for one pixel event.
 *
 * - **campaign params (last touch)**: from the event's own URL when it has one — the Shopify pixel sandbox
 *   is created per page render, but the checkout SPA can navigate without re-running `register()`, so the
 *   boot URL and the event URL can differ. DOM events (`clicked`, `input_*`, `form_submitted`) have no
 *   document context and fall back to the boot snapshot. Keys are plain (`utm_source`), see campaign-params.
 * - **`$set_once` (first touch)**: boot snapshot (`$initial_utm_*` + `$initial_browser` …), nulls stripped.
 * - **`$set`**: customer fields only (omitted when there is no customer; nulls stripped so an absent phone/lastName
 *   no longer clobbers an existing person property). Browser / URL / UTM person properties are lifted from event properties
 *   by PostHog ingestion on every event, so sending them explicitly is redundant and would pin stale
 *   boot-time values on the person.
 * - **anonymous**: no `$set` / `$set_once` at all — consent refused means we never write person properties,
 *   on any event (previously only `page_viewed` was protected).
 */
export function buildEventProperties(args: BuildEventPropertiesArgs): Record<string, unknown> {
  const campaign = args.eventHref ? calculateCampaignParams(args.eventHref) : args.initCampaign;
  const properties: Record<string, unknown> = {
    ...args.base,
    ...campaign.lastTouchCampaignParams,
  };
  if (!args.anonymous) {
    const set = stripNulls({ ...(args.customer ?? {}) });
    if (Object.keys(set).length > 0) properties.$set = set;
    properties.$set_once = stripNulls({
      ...args.setOnceBase,
      ...args.initCampaign.firstTouchCampaignParams,
    });
  }
  return properties;
}

/**
 * Query parameters PostHog treats as campaign/attribution params.
 * Mirrors posthog-js's CAMPAIGN_PARAMS list.
 */
export const CAMPAIGN_PARAMS = [
  'gclid', // google ads
  'gclsrc', // google ads 360
  'dclid', // google display ads
  'gbraid', // google ads, web to app
  'wbraid', // google ads, app to web
  'fbclid', // facebook
  'msclkid', // microsoft
  'twclid', // twitter
  'li_fat_id', // linkedin
  'igshid', // instagram
  'ttclid', // tiktok
  'rdt_cid', // reddit
  'epik', // pinterest
  'qclid', // quora
  'sccid', // snapchat
  'irclid', // impact
  '_kx', // klaviyo
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gad_source', // google ads source
  'mc_cid', // mailchimp campaign id
]

export type CampaignParams = {
  /** `$initial_<param>` keys — for `$set_once` (first touch). */
  firstTouchCampaignParams: Record<string, string>;
  /** Plain `<param>` keys — event properties and last-touch person properties. */
  lastTouchCampaignParams: Record<string, string>;
};

/**
 * Extract campaign params from a URL, following posthog-js naming conventions:
 *
 * - last-touch keys are **un-prefixed** (`utm_source`, `gclid`, …). PostHog's sessions table derives
 *   `$entry_utm_source` / `$channel_type` from the plain `utm_source` event property, and person-property
 *   ingestion lifts the same plain keys. A `$utm_source` key is read by nothing (that was the bug that
 *   made every pixel-first session lose its channel attribution).
 * - first-touch keys are `$initial_<param>` — used in `$set_once`.
 *
 * Missing or empty params are **omitted**, never sent as `null`: an explicit `null` inside `$set_once`
 * is stored by PostHog and permanently blocks the real first-touch value from ever being written.
 *
 * Never throws — an unparsable URL yields empty objects (this runs inside `register()`; a throw there
 * would disable the whole pixel).
 */
export function calculateCampaignParams(url: string): CampaignParams {
  let searchParams: URLSearchParams;
  try {
    searchParams = new URL(url).searchParams;
  } catch {
    return { firstTouchCampaignParams: {}, lastTouchCampaignParams: {} };
  }
  const firstTouchCampaignParams: Record<string, string> = {};
  const lastTouchCampaignParams: Record<string, string> = {};
  for (const param of CAMPAIGN_PARAMS) {
    const value = searchParams.get(param);
    if (!value) continue;
    lastTouchCampaignParams[param] = value;
    firstTouchCampaignParams[`$initial_${param}`] = value;
  }
  return { firstTouchCampaignParams, lastTouchCampaignParams };
}

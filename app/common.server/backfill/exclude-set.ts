/**
 * TODO(multi-shop): If pixiehog-app ever supports multiple shops sharing one
 * PostHog project, the exclude-set key must include the shop identifier
 * (e.g. `affiliation`) to avoid cross-shop order ID collisions. Currently
 * Lightinderm uses one PostHog token per shop, so this is safe. Fix:
 * - Add `properties.affiliation AS shop` to HOGQL_ORDER_COMPLETED
 * - Key becomes `${orderId}:${lib}:${shop}`
 * - Update shouldSkipOrderCompleted() to accept shop param
 */

/**
 * Pre-fetches the set of (order_id, $lib) pairs already captured in PostHog
 * for this shop, so the orchestrator can skip events the live webhook covered
 * during the 2026-04-14 → Phase-0-deploy window.
 *
 * Uses PostHog's HogQL Query API:
 *   POST {apiHost}/api/projects/:project/query/
 * Docs: https://posthog.com/docs/api/queries
 *
 * The PostHog *project* id is NOT the same as the project API key. Callers
 * must pass the personal API key + project id explicitly. We don't have those
 * in `Shop` today; the api.backfill action accepts them as form fields and
 * passes them in.
 */

export interface ExcludeSetCredentials {
  /** Personal API Key (Bearer token), NOT the public project key. */
  personalApiKey: string;
  /** PostHog project numeric id (e.g. "103976"). */
  projectId: string;
  /** Same apiHost as Shop.posthogApiHost — NOTE: trailing slash trimmed. */
  apiHost: string;
}

export interface ExcludeSet {
  /** Stringified `${order_id}:${lib}` pairs already in PostHog. */
  pairs: Set<string>;
  totalRowsFetched: number;
}

const HOGQL_ORDER_COMPLETED = `
  SELECT properties.order_id AS order_id, properties.$lib AS lib
  FROM events
  WHERE event = 'Order Completed' AND properties.order_id != ''
  LIMIT 500000
`;

/**
 * Hits the HogQL Query API and returns a set keyed by `${order_id}:${lib}`.
 * Errors are NOT swallowed — caller decides whether to abort the backfill or
 * continue with an empty set (which would risk dupes).
 */
export async function fetchExcludeSet(creds: ExcludeSetCredentials): Promise<ExcludeSet> {
  const url = `${creds.apiHost.replace(/\/$/, "")}/api/projects/${creds.projectId}/query/`;
  const body = {
    query: { kind: "HogQLQuery", query: HOGQL_ORDER_COMPLETED },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.personalApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostHog HogQL query failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as { results?: Array<[string, string]>; columns?: string[] };
  const rows = json.results ?? [];

  const pairs = new Set<string>();
  for (const row of rows) {
    const [orderId, lib] = row;
    if (!orderId) continue;
    pairs.add(`${orderId}:${lib ?? ""}`);
  }

  console.log(`[backfill] exclude-set fetched ${rows.length} rows`);
  if (rows.length >= 500000) {
    throw new Error("[backfill] exclude-set hit LIMIT 500000 — results truncated, cannot safely backfill. Contact support.");
  }

  return { pairs, totalRowsFetched: rows.length };
}

/** Helper used by the orchestrator at emit time. */
export function shouldSkipOrderCompleted(
  excludeSet: ExcludeSet,
  orderId: number | string,
  lib: string,
): boolean {
  return excludeSet.pairs.has(`${orderId}:${lib}`);
}

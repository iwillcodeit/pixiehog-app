const LIB_NAME = "nuances-server";
const LIB_VERSION = "1.0.0";
const FETCH_TIMEOUT_MS = 5000;
const BACKFILL_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface PostHogConfig {
  apiKey: string;
  apiHost: string;
}

export interface PostHogEvent {
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
  uuid?: string;
}

export interface CaptureOptions {
  /**
   * When true, every event in the batch is flagged with
   * `historical_migration: true` so PostHog's ingestion pipeline routes it
   * through the historical-migration path (no live alerts, no anomaly
   * detection on these timestamps). Used by the Shopify backfill.
   */
  historical?: boolean;
}

export async function capturePostHogEvents(
  config: PostHogConfig,
  events: PostHogEvent[],
  options: CaptureOptions = {},
): Promise<boolean> {
  const batch = events.map((e) => ({
    event: e.event,
    properties: {
      distinct_id: e.distinct_id,
      $lib: LIB_NAME,
      $lib_version: LIB_VERSION,
      ...e.properties,
    },
    timestamp: e.timestamp,
    ...(e.uuid ? { uuid: e.uuid } : {}),
  }));

  const url = `${config.apiHost.replace(/\/$/, "")}/batch/`;
  const body = JSON.stringify({
    api_key: config.apiKey,
    ...(options.historical ? { historical_migration: true } : {}),
    batch,
  });
  const timeoutMs = options.historical ? BACKFILL_TIMEOUT_MS : FETCH_TIMEOUT_MS;
  const retries = options.historical ? MAX_RETRIES : 1;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
      const text = await res.text().catch(() => "");
      console.error(`[nuances-server] PostHog returned ${res.status} (attempt ${attempt}/${retries}): ${text}`);
      if (res.status === 429 && attempt < retries) {
        // Back off on rate limit: 2s, 4s, 8s
        await new Promise((r) => { const id = globalThis.setTimeout(r, 2000 * Math.pow(2, attempt - 1)); void id; });
        continue;
      }
    } catch (err) {
      console.error(`[nuances-server] PostHog capture failed (attempt ${attempt}/${retries}):`, err);
      if (attempt < retries) {
        await new Promise((r) => { const id = globalThis.setTimeout(r, 2000 * Math.pow(2, attempt - 1)); void id; });
        continue;
      }
    }
    if (attempt === retries) return false;
  }
  return false;
}

export async function identifyPostHog(
  config: PostHogConfig,
  distinctId: string,
  $set: Record<string, unknown>,
  $set_once?: Record<string, unknown>,
  timestamp?: string,
  options: CaptureOptions = {},
): Promise<void> {
  await capturePostHogEvents(
    config,
    [
      {
        event: "$identify",
        distinct_id: distinctId,
        properties: {
          $set,
          ...($set_once ? { $set_once } : {}),
        },
        timestamp,
      },
    ],
    options,
  );
}

export async function aliasPostHog(
  config: PostHogConfig,
  distinctId: string,
  alias: string
): Promise<void> {
  await capturePostHogEvents(config, [
    {
      event: "$create_alias",
      distinct_id: distinctId,
      properties: { alias },
    },
  ]);
}

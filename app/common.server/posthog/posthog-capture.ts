const LIB_NAME = "nuances-server";
const LIB_VERSION = "1.0.0";
const FETCH_TIMEOUT_MS = 5000;

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

export async function capturePostHogEvents(
  config: PostHogConfig,
  events: PostHogEvent[]
): Promise<void> {
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.apiKey, batch }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[nuances-server] PostHog returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    console.error("[nuances-server] PostHog capture failed:", err);
  }
}

export async function identifyPostHog(
  config: PostHogConfig,
  distinctId: string,
  $set: Record<string, unknown>,
  $set_once?: Record<string, unknown>,
  timestamp?: string
): Promise<void> {
  await capturePostHogEvents(config, [
    {
      event: "$identify",
      distinct_id: distinctId,
      properties: {
        $set,
        ...($set_once ? { $set_once } : {}),
      },
      timestamp,
    },
  ]);
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

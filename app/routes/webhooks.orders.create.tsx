import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { capturePostHogEvents, identifyPostHog } from "../common.server/posthog/posthog-capture";
import { mapOrderCompleted } from "../common.server/posthog/mappers/order-completed";
import { resolveDistinctId, buildIdentifyProperties } from "../common.server/posthog/identity";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const shopConfig = await db.shop.findUnique({ where: { shop } });
  if (!shopConfig?.posthogApiKey || !shopConfig?.posthogApiHost || !shopConfig.serverSideEnabled) {
    return new Response();
  }

  const order = payload as any;
  const distinctId = resolveDistinctId(order);
  if (!distinctId) {
    return new Response();
  }

  const config = { apiKey: shopConfig.posthogApiKey, apiHost: shopConfig.posthogApiHost };
  const isAnonymous = shopConfig.dataCollectionStrategy !== "non-anonymized";
  const isWebOrder = order.source_name === "web";

  const promises: Promise<void>[] = [];

  // Skip Order Completed for web orders — the web pixel already captures it
  // with session, UTM, replay, and feature flag data that the server doesn't have.
  // Only send for non-web channels (subscriptions, POS, draft orders, API, etc.)
  if (!isWebOrder) {
    const eventProps = mapOrderCompleted(order, shop);
    promises.push(
      capturePostHogEvents(config, [
        {
          event: "Order Completed",
          distinct_id: distinctId,
          properties: eventProps,
          timestamp: order.created_at,
        },
      ]),
    );
  }

  // Always send $identify — enriches the person profile regardless of channel
  if (!isAnonymous) {
    const { $set, $set_once } = buildIdentifyProperties(order);
    promises.push(identifyPostHog(config, distinctId, $set, $set_once, order.created_at));
  }

  await Promise.allSettled(promises);

  return new Response();
};

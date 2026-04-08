import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { capturePostHogEvents, identifyPostHog } from "../common.server/posthog/posthog-capture";
import { mapOrderCompleted } from "../common.server/posthog/mappers/order-completed";
import { resolveDistinctId, buildIdentifyProperties } from "../common.server/posthog/identity";
import { generateCheckoutEventUUID } from "../common.server/posthog/dedup";

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
  const eventProps = mapOrderCompleted(order, shop);
  const isAnonymous = shopConfig.dataCollectionStrategy !== "non-anonymized";

  // Use checkout_token for dedup UUID (matches web pixel's checkout.token)
  const eventUUID = order.checkout_token
    ? generateCheckoutEventUUID(shop, order.checkout_token, "Order Completed")
    : undefined;

  const promises: Promise<void>[] = [
    capturePostHogEvents(config, [
      {
        event: "Order Completed",
        distinct_id: distinctId,
        properties: eventProps,
        timestamp: order.created_at,
        uuid: eventUUID,
      },
    ]),
  ];

  // Only send $identify with PII when data collection strategy allows it
  if (!isAnonymous) {
    const { $set, $set_once } = buildIdentifyProperties(order);
    promises.push(identifyPostHog(config, distinctId, $set, $set_once));
  }

  await Promise.allSettled(promises);

  return new Response();
};

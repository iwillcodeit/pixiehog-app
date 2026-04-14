import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { v5 as uuidv5 } from "uuid";
import { capturePostHogEvents, identifyPostHog } from "../common.server/posthog/posthog-capture";
import { resolveDistinctId, buildIdentifyProperties } from "../common.server/posthog/identity";
import { PIXIEHOG_NAMESPACE } from "../common.server/posthog/dedup";

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

  // Dedup UUID includes updated_at so each status change gets through
  // but Shopify webhook retries (same updated_at) are deduplicated
  const dedupUUID = order.updated_at
    ? uuidv5(`${shop}:${order.id}:${order.updated_at}:Order Updated`, PIXIEHOG_NAMESPACE)
    : undefined;

  const promises: Promise<void>[] = [
    capturePostHogEvents(config, [
      {
        event: "Order Updated",
        distinct_id: distinctId,
        properties: {
          order_id: String(order.id),
          order_number: order.order_number || null,
          order_name: order.name || null,
          financial_status: order.financial_status || null,
          fulfillment_status: order.fulfillment_status || null,
          total: order.total_price ? parseFloat(order.total_price) : null,
          currency: order.currency || null,
          source_name: order.source_name || null,
          affiliation: shop,
        },
        timestamp: order.updated_at,
        uuid: dedupUUID,
      },
    ]),
  ];

  if (!isAnonymous) {
    const { $set, $set_once } = buildIdentifyProperties(order);
    promises.push(identifyPostHog(config, distinctId, $set, $set_once, order.updated_at));
  }

  await Promise.allSettled(promises);

  return new Response();
};

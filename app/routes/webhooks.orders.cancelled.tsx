import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { capturePostHogEvents } from "../common.server/posthog/posthog-capture";
import { mapOrderCancelled } from "../common.server/posthog/mappers/order-cancelled";
import { resolveDistinctId } from "../common.server/posthog/identity";

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
  const eventProps = mapOrderCancelled(order, shop);

  await capturePostHogEvents(config, [
    {
      event: "Order Cancelled",
      distinct_id: distinctId,
      properties: eventProps,
      timestamp: order.cancelled_at || order.updated_at,
    },
  ]);

  return new Response();
};

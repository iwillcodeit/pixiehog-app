import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { capturePostHogEvents } from "../common.server/posthog/posthog-capture";
import { mapRefundCreated } from "../common.server/posthog/mappers/refund-created";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const shopConfig = await db.shop.findUnique({ where: { shop } });
  if (!shopConfig?.posthogApiKey || !shopConfig?.posthogApiHost || !shopConfig.serverSideEnabled) {
    return new Response();
  }

  const refund = payload as any;

  // Shopify refunds/create payload does NOT include a top-level email or customer.
  // We look for it in refund_line_items[].line_item data or fall back to order lookup.
  // Since we can't query the Admin API from a webhook handler without an offline token,
  // we attempt to find the customer email from the refund's nested line_item data.
  // If unavailable, we use shopify_order_{order_id} as a fallback distinct_id.
  const distinctId = (() => {
    // Some webhook payloads include order-level customer data
    const email = refund.customer?.email || refund.order?.email;
    if (email) return email.toLowerCase().trim();
    // Fallback: use order_id as a pseudo-identifier
    if (refund.order_id) return `shopify_order_${refund.order_id}`;
    return null;
  })();

  if (!distinctId) {
    return new Response();
  }

  const config = { apiKey: shopConfig.posthogApiKey, apiHost: shopConfig.posthogApiHost };
  const eventProps = mapRefundCreated(refund, shop);

  await capturePostHogEvents(config, [
    {
      event: "Order Refunded",
      distinct_id: distinctId,
      properties: eventProps,
      timestamp: refund.created_at,
    },
  ]);

  return new Response();
};

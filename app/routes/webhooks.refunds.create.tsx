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

  // Shopify refunds/create payload does NOT include customer data directly.
  // We attempt to extract email from nested structures if present.
  // If no email is available, we skip the event entirely to avoid creating
  // orphaned PostHog profiles that can't merge with the customer's main profile.
  const email = refund.customer?.email || refund.order?.email || refund.email;
  if (!email) {
    return new Response();
  }

  const distinctId = email.toLowerCase().trim();
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

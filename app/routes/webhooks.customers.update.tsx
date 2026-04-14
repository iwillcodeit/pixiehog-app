import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { identifyPostHog } from "../common.server/posthog/posthog-capture";
import {
  resolveCustomerDistinctId,
  buildCustomerIdentifyProperties,
} from "../common.server/posthog/identity";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const shopConfig = await db.shop.findUnique({ where: { shop } });
  if (!shopConfig?.posthogApiKey || !shopConfig?.posthogApiHost || !shopConfig.serverSideEnabled) {
    return new Response();
  }

  // Only send $identify with PII when data collection strategy explicitly allows it
  if (shopConfig.dataCollectionStrategy !== "non-anonymized") {
    return new Response();
  }

  const customer = payload as any;
  const distinctId = resolveCustomerDistinctId(customer);
  if (!distinctId) {
    return new Response();
  }

  const config = { apiKey: shopConfig.posthogApiKey, apiHost: shopConfig.posthogApiHost };
  const { $set, $set_once } = buildCustomerIdentifyProperties(customer);

  await identifyPostHog(config, distinctId, $set, $set_once, customer.updated_at);

  return new Response();
};

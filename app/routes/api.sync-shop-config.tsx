import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const VALID_STRATEGIES = ["anonymized", "non-anonymized", "non-anonymized-by-consent"] as const;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = await request.json();

  // Validate data_collection_strategy to prevent arbitrary values bypassing PII guards
  const strategy = VALID_STRATEGIES.includes(body.data_collection_strategy)
    ? body.data_collection_strategy
    : "anonymized";

  await db.shop.upsert({
    where: { shop: session.shop },
    update: {
      posthogApiKey: body.posthog_api_key || null,
      posthogApiHost: body.posthog_api_host || null,
      dataCollectionStrategy: strategy,
      serverSideEnabled: body.server_side_enabled === true,
    },
    create: {
      shop: session.shop,
      posthogApiKey: body.posthog_api_key || null,
      posthogApiHost: body.posthog_api_host || null,
      dataCollectionStrategy: strategy,
      serverSideEnabled: body.server_side_enabled === true,
    },
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

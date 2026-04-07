import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = await request.json();

  await db.shop.upsert({
    where: { shop: session.shop },
    update: {
      posthogApiKey: body.posthog_api_key || null,
      posthogApiHost: body.posthog_api_host || null,
      dataCollectionStrategy: body.data_collection_strategy || "anonymized",
      serverSideEnabled: body.server_side_enabled ?? false,
    },
    create: {
      shop: session.shop,
      posthogApiKey: body.posthog_api_key || null,
      posthogApiHost: body.posthog_api_host || null,
      dataCollectionStrategy: body.data_collection_strategy || "anonymized",
      serverSideEnabled: body.server_side_enabled ?? false,
    },
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

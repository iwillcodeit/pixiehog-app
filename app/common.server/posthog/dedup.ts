import { v5 as uuidv5 } from "uuid";

/**
 * Fixed namespace UUID for PixieHog deterministic event UUIDs.
 * Generated once, never changes. Used as the namespace for uuidv5.
 *
 * CRITICAL: This value MUST match PIXIEHOG_NAMESPACE in
 * extensions/web-pixel/src/index.ts
 */
export const PIXIEHOG_NAMESPACE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/**
 * Generates a deterministic UUID for a PostHog event based on shop domain,
 * checkout token, and event name. Uses checkout_token (not order ID) because
 * it's available in both the web pixel (checkout.token) and the webhook
 * payload (order.checkout_token), even before the order is fully created.
 *
 * Both the web pixel and server-side webhook use this same scheme to produce
 * identical UUIDs for deduplication.
 *
 * @example generateCheckoutEventUUID("myshop.myshopify.com", "abc123token", "Order Completed")
 */
export function generateCheckoutEventUUID(
  shopDomain: string,
  checkoutToken: string,
  eventName: string
): string {
  if (!shopDomain.endsWith(".myshopify.com")) {
    console.warn(`[pixiehog-dedup] shopDomain "${shopDomain}" does not look like a myshopify domain — dedup UUIDs may not match the web pixel`);
  }
  return uuidv5(`${shopDomain}:${checkoutToken}:${eventName}`, PIXIEHOG_NAMESPACE);
}

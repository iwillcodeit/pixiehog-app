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
    console.warn(`[nuances-dedup] shopDomain "${shopDomain}" does not look like a myshopify domain — dedup UUIDs may not match the web pixel`);
  }
  return uuidv5(`${shopDomain}:${checkoutToken}:${eventName}`, PIXIEHOG_NAMESPACE);
}

/**
 * Deterministic UUID for any order event (web or non-web).
 *
 * Prefers `checkoutToken` so server-side and web-pixel events for the same
 * Online Store order produce identical UUIDs (matches generateCheckoutEventUUID).
 *
 * Falls back to `order_${orderId}` for orders without a checkout token
 * (subscriptions, POS, draft orders, API). This guarantees backfill events
 * match live webhook events for the same order, preventing duplicates when
 * historical Shopify data is replayed through PostHog `/batch/` with
 * `historical_migration: true`.
 */
export function generateOrderEventUUID(
  shopDomain: string,
  checkoutToken: string | null | undefined,
  orderId: number | string,
  eventName: string,
): string {
  if (!shopDomain.endsWith(".myshopify.com")) {
    console.warn(`[nuances-dedup] shopDomain "${shopDomain}" does not look like a myshopify domain — dedup UUIDs may not match the web pixel`);
  }
  const seed = checkoutToken
    ? `${shopDomain}:${checkoutToken}:${eventName}`
    : `${shopDomain}:order_${orderId}:${eventName}`;
  return uuidv5(seed, PIXIEHOG_NAMESPACE);
}

/**
 * Deterministic UUID for a refund event. Refunds have no checkout token
 * dimension; one refund_id maps to exactly one PostHog "Order Refunded" event.
 */
export function generateRefundUUID(
  shopDomain: string,
  refundId: number | string,
): string {
  return uuidv5(`${shopDomain}:refund_${refundId}:Order Refunded`, PIXIEHOG_NAMESPACE);
}

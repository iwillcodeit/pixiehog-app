/**
 * Maps a Shopify orders/cancelled webhook payload to PostHog "Order Cancelled".
 */

interface ShopifyOrderCancelledPayload {
  id: number;
  order_number?: number;
  name?: string;
  currency?: string;
  total_price?: string;
  cancel_reason?: string | null;
  cancelled_at?: string | null;
  source_name?: string | null;
  [key: string]: unknown;
}

function parseAmount(value: string | undefined | null): number | null {
  if (value == null) return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

export function mapOrderCancelled(order: ShopifyOrderCancelledPayload, shopDomain: string) {
  return {
    order_id: String(order.id),
    order_number: order.order_number || null,
    order_name: order.name || null,
    total: parseAmount(order.total_price),
    currency: order.currency || null,
    cancel_reason: order.cancel_reason || null,
    cancelled_at: order.cancelled_at || null,
    affiliation: shopDomain,
    source_name: order.source_name || null,
  };
}

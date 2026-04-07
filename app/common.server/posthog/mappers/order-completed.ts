/**
 * Maps a Shopify orders/create webhook payload to the PostHog
 * "Order Completed" e-commerce spec event.
 *
 * Mirrors the web pixel's orderCompletedSpec but operates on the
 * REST webhook payload shape instead of the Web Pixel API shape.
 */

interface ShopifyLineItem {
  id?: number;
  product_id?: number | null;
  variant_id?: number | null;
  sku?: string | null;
  title?: string;
  variant_title?: string | null;
  vendor?: string | null;
  quantity?: number;
  price?: string;
  total_discount?: string;
  discount_allocations?: Array<{
    amount?: string;
    discount_application_index?: number;
  }>;
  product_exists?: boolean;
}

interface ShopifyOrderPayload {
  id: number;
  order_number?: number;
  name?: string;
  checkout_token?: string | null;
  currency?: string;
  total_price?: string;
  subtotal_price?: string;
  total_tax?: string;
  total_discounts?: string;
  total_shipping_price_set?: {
    shop_money?: { amount?: string; currency_code?: string };
  };
  discount_codes?: Array<{ code?: string; amount?: string; type?: string }>;
  line_items?: ShopifyLineItem[];
  source_name?: string | null;
  [key: string]: unknown;
}

function parseAmount(value: string | undefined | null): number | null {
  if (value == null) return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

export function mapOrderCompleted(order: ShopifyOrderPayload, shopDomain: string) {
  const subtotal = parseAmount(order.subtotal_price);
  const total = parseAmount(order.total_price);
  const tax = parseAmount(order.total_tax);
  const shipping = parseAmount(order.total_shipping_price_set?.shop_money?.amount);
  const discount = parseAmount(order.total_discounts);

  const coupon =
    order.discount_codes && order.discount_codes.length > 0
      ? order.discount_codes.map((d) => d.code).join(",")
      : null;

  const products = (order.line_items || []).map((item, index) => ({
    product_id: item.product_id ? String(item.product_id) : null,
    sku: item.sku || null,
    category: null,
    name: item.title || null,
    brand: item.vendor || null,
    variant: item.variant_title || null,
    price: parseAmount(item.price),
    quantity: item.quantity || null,
    coupon:
      item.discount_allocations && item.discount_allocations.length > 0
        ? order.discount_codes?.map((d) => d.code).join(",") || null
        : null,
    position: index + 1,
    url: null,
    image_url: null,
  }));

  return {
    checkout_id: order.checkout_token || null,
    order_id: String(order.id),
    order_number: order.order_number || null,
    order_name: order.name || null,
    affiliation: shopDomain,
    subtotal,
    total,
    revenue: subtotal,
    shipping,
    tax,
    discount,
    coupon,
    currency: order.currency || null,
    source_name: order.source_name || null,
    products,
  };
}

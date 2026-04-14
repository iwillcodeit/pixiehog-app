/**
 * Maps a Shopify refunds/create webhook payload to PostHog "Order Refunded".
 */

interface ShopifyRefundLineItem {
  id?: number;
  line_item_id?: number;
  quantity?: number;
  subtotal?: number;
  subtotal_set?: {
    shop_money?: { amount?: string; currency_code?: string };
  };
  total_tax?: number;
  total_tax_set?: {
    shop_money?: { amount?: string; currency_code?: string };
  };
  line_item?: {
    id?: number;
    product_id?: number | null;
    variant_id?: number | null;
    sku?: string | null;
    title?: string;
    variant_title?: string | null;
    vendor?: string | null;
    price?: string;
    quantity?: number;
  };
}

interface ShopifyRefundPayload {
  id: number;
  order_id: number;
  created_at?: string;
  note?: string | null;
  refund_line_items?: ShopifyRefundLineItem[];
  order_adjustments?: Array<{
    id?: number;
    amount?: string;
    tax_amount?: string;
    kind?: string;
    reason?: string;
  }>;
  [key: string]: unknown;
}

function parseAmount(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  const num = typeof value === "string" ? parseFloat(value) : value;
  return isNaN(num) ? null : num;
}

export function mapRefundCreated(refund: ShopifyRefundPayload, shopDomain: string) {
  const refundLineItems = (refund.refund_line_items || []).map((rli) => ({
    product_id: rli.line_item?.product_id ? String(rli.line_item.product_id) : null,
    sku: rli.line_item?.sku || null,
    name: rli.line_item?.title || null,
    variant: rli.line_item?.variant_title || null,
    brand: rli.line_item?.vendor || null,
    quantity: rli.quantity || null,
    subtotal: parseAmount(rli.subtotal_set?.shop_money?.amount ?? rli.subtotal),
  }));

  // Sum up refund amounts from line items
  const totalRefund = refundLineItems.reduce((sum, item) => {
    return sum + (item.subtotal || 0);
  }, 0);

  return {
    order_id: String(refund.order_id),
    refund_id: String(refund.id),
    total: totalRefund || null,
    note: refund.note || null,
    affiliation: shopDomain,
    products: refundLineItems,
  };
}

import { describe, expect, it } from "vitest";
import { mapOrderCompleted } from "../order-completed";

const baseOrder = {
  id: 123,
  order_number: 1001,
  currency: "EUR",
  total_price: "120.00",
  subtotal_price: "100.00",
  line_items: [],
} as any;

describe("mapOrderCompleted — is_first_order", () => {
  it("is false for subscription renewals (never a first order)", () => {
    const props = mapOrderCompleted({ ...baseOrder, source_name: "subscription_contract_checkout_one" }, "shop.myshopify.com");
    expect(props.is_first_order).toBe(false);
  });

  it("is null (unknown) for other server-side channels", () => {
    expect(mapOrderCompleted({ ...baseOrder, source_name: "shopify_draft_order" }, "s").is_first_order).toBeNull();
    expect(mapOrderCompleted({ ...baseOrder, source_name: "3890849" }, "s").is_first_order).toBeNull();
    expect(mapOrderCompleted({ ...baseOrder, source_name: null }, "s").is_first_order).toBeNull();
  });

  it("keeps the existing shape", () => {
    const props = mapOrderCompleted({ ...baseOrder, source_name: "subscription_contract_checkout_one" }, "shop.myshopify.com");
    expect(props).toEqual({
      checkout_id: null,
      order_id: "123",
      order_number: 1001,
      order_name: null,
      affiliation: "shop.myshopify.com",
      subtotal: 100,
      total: 120,
      revenue: 100,
      shipping: null,
      tax: null,
      discount: null,
      coupon: null,
      currency: "EUR",
      source_name: "subscription_contract_checkout_one",
      financial_status: null,
      fulfillment_status: null,
      payment_gateway_names: null,
      tags: null,
      referring_site: null,
      landing_site: null,
      customer_orders_count: null,
      ordersCount: null,
      presentment_currency: null,
      event_source: "server",
      has_subscription: false,
      is_first_order: false,
      products: [],
    });
  });
});

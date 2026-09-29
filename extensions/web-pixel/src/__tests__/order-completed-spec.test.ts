import { describe, expect, it } from 'vitest';
import { orderCompletedSpec } from '../posthog-ecommerce-spec/events/order_completed';

const shop = { myshopifyDomain: 'lightinderm.myshopify.com' } as any;

/** Minimal checkout_completed event; only the fields orderCompletedSpec reads. */
const checkoutCompleted = (order: unknown) =>
  ({
    name: 'checkout_completed',
    data: {
      checkout: {
        token: 'tok',
        order,
        subtotalPrice: { amount: 100 },
        totalPrice: { amount: 120 },
        shippingLine: { price: { amount: 5 } },
        totalTax: { amount: 15 },
        discountsAmount: { amount: 0 },
        discountApplications: [],
        currencyCode: 'EUR',
        lineItems: [],
      },
    },
  }) as any;

describe('orderCompletedSpec — is_first_order', () => {
  it('surfaces Shopify isFirstOrder=true as a top-level boolean', () => {
    const spec = orderCompletedSpec(shop, checkoutCompleted({ id: 'o1', customer: { id: 'c1', isFirstOrder: true } }));
    expect(spec.is_first_order).toBe(true);
    expect(spec.order_id).toBe('o1');
  });

  it('surfaces isFirstOrder=false', () => {
    const spec = orderCompletedSpec(shop, checkoutCompleted({ id: 'o1', customer: { id: 'c1', isFirstOrder: false } }));
    expect(spec.is_first_order).toBe(false);
  });

  it('is null when Shopify does not provide the flag or the customer', () => {
    expect(orderCompletedSpec(shop, checkoutCompleted({ id: 'o1', customer: { id: 'c1', isFirstOrder: null } })).is_first_order).toBeNull();
    expect(orderCompletedSpec(shop, checkoutCompleted({ id: 'o1', customer: null })).is_first_order).toBeNull();
    expect(orderCompletedSpec(shop, checkoutCompleted(null)).is_first_order).toBeNull();
  });
});

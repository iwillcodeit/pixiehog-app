/**
 * GraphQL bulk JSONL → REST-shape projection.
 *
 * The JSONL emitted by Shopify's bulk op writes child connections (lineItems,
 * refundLineItems) as separate lines whose `__parentId` references the parent
 * order. assembleOrder() reattaches the children before we project to the
 * `ShopifyOrderPayload` shape that the existing mappers
 * (mapOrderCompleted / mapOrderCancelled / mapRefundCreated) consume.
 *
 * Currency: we always write `presentmentMoney.amount` into the REST-style
 * fields. PostHog dashboards built off webhook events expect presentment
 * currency (matches what the live orders/create webhook pushes).
 */

import type { ShopifyCustomerPayload } from "../posthog/identity";

// ---- GraphQL node shapes (loose) ----

interface MoneyBag {
  shopMoney?: { amount?: string; currencyCode?: string };
  presentmentMoney?: { amount?: string; currencyCode?: string };
}

export interface GqlLineItemNode {
  id: string;
  __parentId?: string;
  title?: string | null;
  variantTitle?: string | null;
  vendor?: string | null;
  sku?: string | null;
  quantity?: number;
  product?: { id?: string; legacyResourceId?: string | null } | null;
  variant?: { id?: string; legacyResourceId?: string | null; sku?: string | null } | null;
  originalUnitPriceSet?: MoneyBag;
  discountedUnitPriceSet?: MoneyBag;
  totalDiscountSet?: MoneyBag;
  sellingPlanAllocation?: { sellingPlan?: { name?: string } } | null;
}

export interface GqlRefundLineItemNode {
  __parentId?: string;
  quantity?: number;
  lineItem?: {
    id?: string;
    title?: string;
    variantTitle?: string | null;
    vendor?: string | null;
    sku?: string | null;
    product?: { legacyResourceId?: string | null } | null;
    variant?: { legacyResourceId?: string | null; sku?: string | null } | null;
  } | null;
  subtotalSet?: MoneyBag;
  totalTaxSet?: MoneyBag;
}

export interface GqlRefundNode {
  id: string;
  __parentId?: string;
  legacyResourceId?: string;
  createdAt?: string;
  note?: string | null;
}

export interface GqlOrderNode {
  id: string;
  legacyResourceId: string;
  name?: string;
  createdAt?: string;
  processedAt?: string;
  updatedAt?: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  email?: string | null;
  phone?: string | null;
  sourceName?: string | null;
  tags?: string[] | null;
  note?: string | null;
  presentmentCurrencyCode?: string | null;
  currencyCode?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  paymentGatewayNames?: string[] | null;
  totalPriceSet?: MoneyBag;
  subtotalPriceSet?: MoneyBag;
  totalTaxSet?: MoneyBag;
  totalShippingPriceSet?: MoneyBag;
  totalDiscountsSet?: MoneyBag;
  discountCodes?: string[] | null;
  customer?: GqlCustomerNode | null;
  billingAddress?: GqlAddressNode | null;
}

export interface GqlAddressNode {
  city?: string | null;
  province?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
}

export interface GqlCustomerNode {
  id: string;
  legacyResourceId?: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  numberOfOrders?: string | null;
  amountSpent?: { amount?: string; currencyCode?: string };
  tags?: string[] | null;
  state?: string | null;
  verifiedEmail?: boolean;
  createdAt?: string;
  updatedAt?: string;
  defaultAddress?: GqlAddressNode | null;
}

// ---- Assembly: stream child rows into pending parent ----

/**
 * In-memory buffer of one order + its children. The orchestrator drains it
 * once a new top-level order id is observed in the JSONL stream.
 */
export interface AssembledOrder {
  order: GqlOrderNode;
  lineItems: GqlLineItemNode[];
  refunds: Map<string, { refund: GqlRefundNode; refundLineItems: GqlRefundLineItemNode[] }>;
}

export function newAssembledOrder(order: GqlOrderNode): AssembledOrder {
  return { order, lineItems: [], refunds: new Map() };
}

/**
 * Branches a JSONL row to its slot on the in-progress AssembledOrder.
 * Returns true if the row was absorbed; false if it's a new top-level node
 * and the caller should flush the current AssembledOrder before starting a
 * new one.
 */
export function ingestRow(
  current: AssembledOrder | null,
  row: Record<string, unknown>,
): { absorbed: boolean; isOrder: boolean } {
  const id = (row.id as string) ?? "";
  const parentId = row.__parentId as string | undefined;

  // Top-level Order
  if (!parentId && id.startsWith("gid://shopify/Order/")) {
    return { absorbed: false, isOrder: true };
  }

  if (!current) return { absorbed: false, isOrder: false };

  // Refund (parent = Order)
  if (parentId === current.order.id && id.startsWith("gid://shopify/Refund/")) {
    const node = row as unknown as GqlRefundNode;
    current.refunds.set(node.id, { refund: node, refundLineItems: [] });
    return { absorbed: true, isOrder: false };
  }

  // LineItem (parent = Order)
  if (parentId === current.order.id && id.startsWith("gid://shopify/LineItem/")) {
    current.lineItems.push(row as unknown as GqlLineItemNode);
    return { absorbed: true, isOrder: false };
  }

  // RefundLineItem (parent = Refund)
  if (parentId && parentId.startsWith("gid://shopify/Refund/")) {
    const slot = current.refunds.get(parentId);
    if (slot) {
      slot.refundLineItems.push(row as unknown as GqlRefundLineItemNode);
      return { absorbed: true, isOrder: false };
    }
  }

  return { absorbed: false, isOrder: false };
}

// ---- Projections to REST shape ----

function presentment(bag: MoneyBag | undefined): string | undefined {
  return bag?.presentmentMoney?.amount ?? bag?.shopMoney?.amount ?? undefined;
}

function legacyId(gid?: string | null, legacy?: string | null): number | null {
  if (legacy) {
    const n = Number.parseInt(legacy, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (gid) {
    const tail = gid.split("/").pop();
    if (tail) {
      const n = Number.parseInt(tail, 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

/**
 * Project an AssembledOrder into the REST `ShopifyOrderPayload` shape that
 * `mapOrderCompleted` and `buildIdentifyProperties` already consume.
 *
 * Adds a couple of fields the existing mapper looks for via `[key: string]`
 * but that don't exist on the typed interface (financial_status, etc.).
 */
export function toRestOrder(assembled: AssembledOrder) {
  const o = assembled.order;
  const id = legacyId(o.id, o.legacyResourceId);
  if (id == null) throw new Error(`Order missing legacyResourceId: ${o.id}`);

  const line_items = assembled.lineItems.map((li) => ({
    id: legacyId(li.id) ?? undefined,
    product_id: legacyId(li.product?.id, li.product?.legacyResourceId),
    variant_id: legacyId(li.variant?.id, li.variant?.legacyResourceId),
    sku: li.variant?.sku ?? li.sku ?? null,
    title: li.title ?? "",
    variant_title: li.variantTitle ?? null,
    vendor: li.vendor ?? null,
    quantity: li.quantity ?? 0,
    price: presentment(li.originalUnitPriceSet) ?? "0",
    total_discount: presentment(li.totalDiscountSet) ?? "0",
    discount_allocations: [],
    product_exists: true,
    selling_plan_allocation: li.sellingPlanAllocation
      ? { selling_plan: { name: li.sellingPlanAllocation.sellingPlan?.name } }
      : null,
  }));

  const customer = o.customer ? toRestCustomer(o.customer) : null;

  return {
    id,
    name: o.name,
    order_number: o.name ? parseInt(o.name.replace(/\D/g, ""), 10) || null : null,
    checkout_token: null,
    currency: o.presentmentCurrencyCode ?? o.currencyCode ?? null,
    presentment_currency: o.presentmentCurrencyCode ?? null,
    total_price: presentment(o.totalPriceSet),
    subtotal_price: presentment(o.subtotalPriceSet),
    total_tax: presentment(o.totalTaxSet),
    total_discounts: presentment(o.totalDiscountsSet),
    total_shipping_price_set: {
      shop_money: {
        amount: presentment(o.totalShippingPriceSet),
        currency_code: o.totalShippingPriceSet?.presentmentMoney?.currencyCode,
      },
    },
    discount_codes: (o.discountCodes ?? []).map((code) => ({ code })),
    line_items,
    source_name: o.sourceName,
    financial_status: o.displayFinancialStatus ?? null,
    fulfillment_status: o.displayFulfillmentStatus ?? null,
    payment_gateway_names: o.paymentGatewayNames ?? null,
    tags: (o.tags ?? []).join(", "),
    referring_site: null,
    landing_site: null,
    cancelled_at: o.cancelledAt ?? null,
    cancel_reason: o.cancelReason ?? null,
    email: o.email ?? null,
    phone: o.phone ?? null,
    created_at: o.processedAt ?? o.createdAt,
    updated_at: o.updatedAt,
    customer: customer
      ? {
          id: customer.id,
          email: customer.email ?? null,
          first_name: customer.first_name ?? null,
          last_name: customer.last_name ?? null,
          phone: customer.phone ?? null,
          orders_count: customer.orders_count,
          total_spent: customer.total_spent,
          tags: customer.tags ?? "",
          default_address: customer.default_address ?? null,
        }
      : null,
    billing_address: o.billingAddress
      ? {
          city: o.billingAddress.city ?? null,
          province: o.billingAddress.province ?? null,
          country: o.billingAddress.country ?? null,
          country_code: o.billingAddress.countryCodeV2 ?? null,
        }
      : null,
  };
}

/**
 * Projects each refund slot into the REST `ShopifyRefundPayload` shape that
 * `mapRefundCreated` consumes.
 */
export function toRestRefunds(assembled: AssembledOrder) {
  const orderId = legacyId(assembled.order.id, assembled.order.legacyResourceId);
  if (orderId == null) return [];

  const out = [];

  for (const slot of assembled.refunds.values()) {
    const r = slot.refund;
    const refundId = legacyId(r.id, r.legacyResourceId);
    if (refundId == null) continue;

    out.push({
      id: refundId,
      order_id: orderId,
      created_at: r.createdAt,
      note: r.note ?? null,
      refund_line_items: slot.refundLineItems.map((rli) => ({
        line_item_id: legacyId(rli.lineItem?.id) ?? undefined,
        quantity: rli.quantity ?? 0,
        subtotal_set: { shop_money: { amount: presentment(rli.subtotalSet) } },
        total_tax_set: { shop_money: { amount: presentment(rli.totalTaxSet) } },
        line_item: {
          id: legacyId(rli.lineItem?.id) ?? undefined,
          product_id: legacyId(undefined, rli.lineItem?.product?.legacyResourceId) ?? undefined,
          variant_id: legacyId(undefined, rli.lineItem?.variant?.legacyResourceId) ?? undefined,
          sku: rli.lineItem?.variant?.sku ?? rli.lineItem?.sku ?? null,
          title: rli.lineItem?.title ?? "",
          variant_title: rli.lineItem?.variantTitle ?? null,
          vendor: rli.lineItem?.vendor ?? null,
        },
      })),
    });
  }
  return out;
}

/**
 * Project a customers-bulk node (or a customer embedded on an order) into the
 * REST `ShopifyCustomerPayload` shape consumed by `buildCustomerIdentifyProperties`.
 */
export function toRestCustomer(c: GqlCustomerNode): ShopifyCustomerPayload {
  const id = legacyId(c.id, c.legacyResourceId);
  if (id == null) throw new Error(`Customer missing legacyResourceId: ${c.id}`);
  return {
    id,
    email: c.email ?? null,
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    phone: c.phone ?? null,
    orders_count: c.numberOfOrders != null ? (Number.parseInt(c.numberOfOrders, 10) || 0) : undefined,
    total_spent: c.amountSpent?.amount ?? null,
    tags: (c.tags ?? []).join(", "),
    state: c.state ?? undefined,
    verified_email: c.verifiedEmail,
    default_address: c.defaultAddress
      ? {
          city: c.defaultAddress.city ?? null,
          province: c.defaultAddress.province ?? null,
          country: c.defaultAddress.country ?? null,
          country_code: c.defaultAddress.countryCodeV2 ?? null,
        }
      : null,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/**
 * Identity resolution for server-side PostHog events.
 *
 * Priority: customer email > order email > shopify_customer_{id} > null
 * Matches the web pixel's behavior of using email as distinct_id.
 */

const BLOCKED_IDS = new Set([
  "",
  "anonymous",
  "guest",
  "null",
  "undefined",
  "none",
  "unknown",
  "distinctid",
  "distinct_id",
  "id",
  "not_authenticated",
  "email",
  "true",
  "false",
]);

export interface ShopifyOrderPayload {
  id: number;
  email?: string | null;
  created_at?: string;
  customer?: {
    id?: number;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    orders_count?: number;
    total_spent?: string | null;
    tags?: string;
    default_address?: {
      city?: string | null;
      province?: string | null;
      country?: string | null;
      country_code?: string | null;
    } | null;
  } | null;
  billing_address?: {
    city?: string | null;
    province?: string | null;
    country?: string | null;
    country_code?: string | null;
  } | null;
  // Other fields added as needed by mappers
  [key: string]: unknown;
}

export interface ShopifyCustomerPayload {
  id: number;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  orders_count?: number;
  total_spent?: string | null;
  tags?: string;
  state?: string;
  verified_email?: boolean;
  default_address?: {
    city?: string | null;
    province?: string | null;
    country?: string | null;
    country_code?: string | null;
  } | null;
  created_at?: string;
  updated_at?: string;
}

function isValidDistinctId(value: string | null | undefined): value is string {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized.length > 0 && !BLOCKED_IDS.has(normalized);
}

export function resolveDistinctId(
  order: ShopifyOrderPayload
): string | null {
  const customerEmail = order.customer?.email;
  if (isValidDistinctId(customerEmail)) {
    return customerEmail!.toLowerCase().trim();
  }

  const orderEmail = order.email;
  if (isValidDistinctId(orderEmail)) {
    return orderEmail!.toLowerCase().trim();
  }

  if (order.customer?.id) {
    return `shopify_customer_${order.customer.id}`;
  }

  return null;
}

export function resolveCustomerDistinctId(
  customer: ShopifyCustomerPayload
): string | null {
  if (isValidDistinctId(customer.email)) {
    return customer.email!.toLowerCase().trim();
  }

  if (customer.id) {
    return `shopify_customer_${customer.id}`;
  }

  return null;
}

export function buildIdentifyProperties(order: ShopifyOrderPayload): {
  $set: Record<string, unknown>;
  $set_once: Record<string, unknown>;
} {
  const customer = order.customer;
  const address =
    customer?.default_address || order.billing_address;

  const $set: Record<string, unknown> = {};
  const $set_once: Record<string, unknown> = {};

  if (customer?.email) $set.email = customer.email;
  if (customer?.first_name) $set.first_name = customer.first_name;
  if (customer?.last_name) $set.last_name = customer.last_name;
  if (customer?.phone) $set.phone = customer.phone;
  if (customer?.orders_count != null) $set.orders_count = customer.orders_count;
  if (customer?.total_spent != null) $set.total_spent = parseFloat(customer.total_spent || "0");
  if (customer?.tags) $set.tags = customer.tags;
  if (address?.city) $set.city = address.city;
  if (address?.country) $set.country = address.country;
  if (address?.country_code) $set.country_code = address.country_code;

  $set.last_order_date = order.created_at;
  $set.last_order_id = order.id;

  $set_once.first_order_date = order.created_at;
  $set_once.first_order_id = order.id;

  return { $set, $set_once };
}

export function buildCustomerIdentifyProperties(customer: ShopifyCustomerPayload): {
  $set: Record<string, unknown>;
  $set_once: Record<string, unknown>;
} {
  const $set: Record<string, unknown> = {};
  const $set_once: Record<string, unknown> = {};

  if (customer.email) $set.email = customer.email;
  if (customer.first_name) $set.first_name = customer.first_name;
  if (customer.last_name) $set.last_name = customer.last_name;
  if (customer.phone) $set.phone = customer.phone;
  if (customer.orders_count != null) $set.orders_count = customer.orders_count;
  if (customer.total_spent != null) $set.total_spent = parseFloat(customer.total_spent || "0");
  if (customer.tags) $set.tags = customer.tags;
  if (customer.state) $set.customer_state = customer.state;

  const address = customer.default_address;
  if (address?.city) $set.city = address.city;
  if (address?.country) $set.country = address.country;
  if (address?.country_code) $set.country_code = address.country_code;

  $set_once.shopify_customer_created_at = customer.created_at;

  return { $set, $set_once };
}

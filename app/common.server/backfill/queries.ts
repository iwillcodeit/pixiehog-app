/**
 * GraphQL strings for the Shopify Admin Bulk Operations API used by the
 * historical backfill. These are passed verbatim to `bulkOperationRunQuery`.
 *
 * Bulk operations stream results as JSONL where every node appears on its own
 * line and child connections (lineItems, refunds, ...) are emitted as separate
 * lines whose `__parentId` references the parent order's gid.
 *
 * Docs: https://shopify.dev/docs/api/usage/bulk-operations/queries
 */

/**
 * Orders bulk op — fetches every order for the shop (or filtered via
 * `query` arg below) with the line-item, refund, and customer detail needed
 * to reconstruct REST-shape webhook payloads in normalize.ts.
 *
 * The `$queryFilter` placeholder is replaced with a Shopify search syntax
 * filter string (e.g. `created_at:>=2025-01-01 AND created_at:<2026-01-01`).
 * Pass an empty string for "all orders".
 */
export function buildOrdersBulkQuery(queryFilter: string): string {
  // Backslash-escape any double quotes the caller passed in.
  const safeFilter = queryFilter.replace(/"/g, '\\"');
  return `
    mutation {
      bulkOperationRunQuery(
        query: """
          {
            orders(query: "${safeFilter}") {
              edges {
                node {
                  id
                  legacyResourceId
                  name
                  createdAt
                  processedAt
                  updatedAt
                  cancelledAt
                  cancelReason
                  email
                  phone
                  sourceName
                  tags
                  note
                  presentmentCurrencyCode
                  currencyCode
                  displayFinancialStatus
                  displayFulfillmentStatus
                  paymentGatewayNames
                  customerJourneySummary {
                    customerOrderIndex
                    daysToConversion
                  }
                  totalPriceSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  subtotalPriceSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  totalTaxSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  totalShippingPriceSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  totalDiscountsSet {
                    shopMoney { amount currencyCode }
                    presentmentMoney { amount currencyCode }
                  }
                  discountCodes
                  customer {
                    id
                    legacyResourceId
                    email
                    firstName
                    lastName
                    phone
                    numberOfOrders
                    amountSpent { amount currencyCode }
                    tags
                    state
                    createdAt
                    updatedAt
                    defaultAddress {
                      city
                      province
                      country
                      countryCodeV2
                    }
                  }
                  billingAddress {
                    city
                    province
                    country
                    countryCodeV2
                  }
                  lineItems {
                    edges {
                      node {
                        id
                        title
                        variantTitle
                        vendor
                        sku
                        quantity
                        product { id legacyResourceId }
                        variant { id legacyResourceId sku }
                        originalUnitPriceSet {
                          shopMoney { amount currencyCode }
                          presentmentMoney { amount currencyCode }
                        }
                        discountedUnitPriceSet {
                          shopMoney { amount currencyCode }
                          presentmentMoney { amount currencyCode }
                        }
                        totalDiscountSet {
                          shopMoney { amount currencyCode }
                          presentmentMoney { amount currencyCode }
                        }
                        sellingPlanAllocation {
                          sellingPlan { name }
                        }
                      }
                    }
                  }
                  refunds {
                    id
                    legacyResourceId
                    createdAt
                    note
                    refundLineItems(first: 100) {
                      edges {
                        node {
                          quantity
                          lineItem {
                            id
                            title
                            variantTitle
                            vendor
                            sku
                            product { legacyResourceId }
                            variant { legacyResourceId sku }
                          }
                          subtotalSet {
                            shopMoney { amount currencyCode }
                            presentmentMoney { amount currencyCode }
                          }
                          totalTaxSet {
                            shopMoney { amount currencyCode }
                            presentmentMoney { amount currencyCode }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;
}

/**
 * Customers bulk op — final identify pass. Authoritative `total_spent`,
 * `orders_count`, `tags` for every customer, even those with no orders in
 * the date window of the orders bulk op.
 */
export function buildCustomersBulkQuery(queryFilter: string): string {
  const safeFilter = queryFilter.replace(/"/g, '\\"');
  return `
    mutation {
      bulkOperationRunQuery(
        query: """
          {
            customers(query: "${safeFilter}") {
              edges {
                node {
                  id
                  legacyResourceId
                  email
                  firstName
                  lastName
                  phone
                  numberOfOrders
                  amountSpent { amount currencyCode }
                  tags
                  state
                  verifiedEmail
                  createdAt
                  updatedAt
                  defaultAddress {
                    city
                    province
                    country
                    countryCodeV2
                  }
                }
              }
            }
          }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `;
}

/**
 * Poll query — returns the shop's current bulk operation, regardless of which
 * mutation kicked it off. Shopify enforces ONE bulk op per shop at a time.
 */
export const CURRENT_BULK_OPERATION_QUERY = `
  query {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }
`;

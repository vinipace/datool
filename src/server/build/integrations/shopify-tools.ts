import { shopifyCartTools } from "./shopify-cart"
import { shopifyTools as catalogTools } from "./shopify-catalog"
import { shopifyOrderTools } from "./shopify-orders"
import { shopifyCustomerTools } from "./shopify-customers"
import { shopifyTagTools } from "./shopify-order-tags"
import { shopifyOrderCreationTools } from "./shopify-order-create"

export const shopifyTools = [
  ...catalogTools,
  ...shopifyCartTools,
  ...shopifyOrderTools,
  ...shopifyCustomerTools,
  ...shopifyTagTools,
  ...shopifyOrderCreationTools,
]

export const shopifyToolScopes: Record<string, string[]> = {
  SHOPIFY_GET_CART: [],
  SHOPIFY_UPDATE_CART: [],
  SHOPIFY_GET_ORDERS: ["read_orders", "read_customers"],
  SHOPIFY_UPDATE_PROFILE: ["write_customers"],
  SHOPIFY_UPDATE_ADDRESS: ["write_customers"],
  SHOPIFY_ACTIVATE_ACCOUNT: ["write_customers"],
  SHOPIFY_TAG_ORDER: ["write_orders", "read_customers"],
  SHOPIFY_CREATE_ORDER: [
    "write_draft_orders",
    "read_products",
    "read_payment_terms",
    "read_orders",
  ],
}

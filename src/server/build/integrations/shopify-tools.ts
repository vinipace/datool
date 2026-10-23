import { shopifyTools as catalogTools } from "./shopify-catalog"
import { shopifyOrderTools } from "./shopify-orders"
import { shopifyCustomerTools } from "./shopify-customers"
import { shopifyTagTools } from "./shopify-order-tags"

export const shopifyTools = [
  ...catalogTools,
  ...shopifyOrderTools,
  ...shopifyCustomerTools,
  ...shopifyTagTools,
]

export const shopifyToolScopes: Record<string, string[]> = {
  SHOPIFY_GET_ORDERS: ["read_orders", "read_customers"],
  SHOPIFY_UPDATE_PROFILE: ["write_customers"],
  SHOPIFY_UPDATE_ADDRESS: ["write_customers"],
  SHOPIFY_ACTIVATE_ACCOUNT: ["write_customers"],
  SHOPIFY_TAG_ORDER: ["write_orders", "read_customers"],
}

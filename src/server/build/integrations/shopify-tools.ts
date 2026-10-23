import { shopifyCartTools } from "./shopify-cart"
import { shopifyTools as catalogTools } from "./shopify-catalog"
import { shopifyOrderTools } from "./shopify-orders"
import { shopifyCustomerTools } from "./shopify-customers"
import { shopifyTagTools } from "./shopify-order-tags"
import { shopifyOrderCreationTools } from "./shopify-order-create"
import { shopifyCheckoutTools } from "./shopify-order-status"
import { shopifyReturnStatusTools } from "./shopify-return-status"
import { shopifyReturnTools } from "./shopify-return-process"
import { shopifyReturnReadTools } from "./shopify-return-options"

export const shopifyTools = [
  ...catalogTools,
  ...shopifyCartTools,
  ...shopifyOrderTools,
  ...shopifyCustomerTools,
  ...shopifyTagTools,
  ...shopifyOrderCreationTools,
  ...shopifyCheckoutTools,
  ...shopifyReturnReadTools,
  ...shopifyReturnTools,
  ...shopifyReturnStatusTools,
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
  SHOPIFY_CHECK_CHECKOUT: [
    "read_draft_orders",
    "read_orders",
    "read_customers",
  ],
  SHOPIFY_CHECK_RETURN: ["read_returns", "read_orders", "read_customers"],
  SHOPIFY_RETURN_OR_EXCHANGE: [
    "write_returns",
    "write_orders",
    "read_orders",
    "read_customers",
    "read_products",
  ],
  SHOPIFY_GET_RETURN_OPTIONS: [
    "read_orders",
    "read_customers",
    "read_returns",
    "read_products",
  ],
}

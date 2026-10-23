import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import {
  shopifyCartUpdateSchema,
  shopifyCartResultSchema,
} from "@/src/lib/build/shopify-cart"
import { TracerError } from "@/src/server/tracer/errors"
import { ShopifyWriteUncertainError } from "./shopify-mutation"

export function prepareShopifyCart(
  slug: string,
  input: Record<string, unknown>
) {
  if (slug === "SHOPIFY_GET_CART") {
    z.object({}).strict().parse(input)
    return { operation: "read" as const }
  }
  return shopifyCartUpdateSchema.parse(input)
}

export function completeShopifyCart(result: unknown) {
  const parsed = shopifyCartResultSchema.parse(result)
  if (parsed.status !== "completed") {
    if (parsed.status === "uncertain") throw new ShopifyWriteUncertainError()
    throw new TracerError(
      "VALIDATION_ERROR",
      "The store could not complete the cart request. Open your cart to check availability and try again."
    )
  }
  return {
    message: parsed.cart.itemCount
      ? "Here is your current cart."
      : "Your cart is empty.",
    shopifyCart: parsed.cart,
    source: "storefront_browser",
    guidance:
      "Browser-reported cart snapshot. Do not trust its totals for order creation, refunds or payment verification; Shopify must calculate those independently.",
  }
}

export const shopifyCartTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_GET_CART",
    name: "Show shopping cart",
    description:
      "Show the current contents and total of the shopper's actual storefront cart. Available in the Shopify storefront chat for guests and signed-in customers. The shopper opens the cart control to share its contents.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    slug: "SHOPIFY_UPDATE_CART",
    name: "Update shopping cart",
    description:
      "Add variants or set an existing line's quantity in the shopper's storefront cart. Use numeric variant IDs from product results; use lineKey from Get cart to update a line. Quantity zero removes a line. The shopper clicks Update cart to apply the request. Never creates an order or takes payment.",
    inputSchema: {
      ...z.toJSONSchema(shopifyCartUpdateSchema, { target: "draft-7" }),
      type: "object",
    },
  },
]

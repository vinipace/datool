import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import {
  shopifyCartUpdateSchema,
  shopifyCartResultSchema,
} from "@/src/lib/build/shopify-cart"
import { TracerError } from "@/src/server/tracer/errors"
import { ShopifyWriteUncertainError } from "./shopify-mutation"

// Function-calling providers require a root object, not a discriminated union.
// Keep operation-specific validation in prepareShopifyCart before any mutation.
export const shopifyCartToolInputSchema = z.toJSONSchema(
  z
    .object({
      operation: z.enum(["add", "set"]),
      items: shopifyCartUpdateSchema.options[0].shape.items
        .optional()
        .describe("Required for add. Omit for set."),
      lineKey: shopifyCartUpdateSchema.options[1].shape.lineKey
        .optional()
        .describe("Required for set. Use the lineKey returned by Get cart."),
      quantity: shopifyCartUpdateSchema.options[1].shape.quantity
        .optional()
        .describe("Required for set. Zero removes the line."),
    })
    .strict(),
  { target: "draft-7" }
)

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
      "Show the shopper's cart and checkout link. Storefront chat uses the browser cart; messaging channels use a separate cart saved to this conversation. Shopify confirms final totals at checkout.",
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
      "Add variants or set an existing line's quantity in the shopper's cart (browser cart on the storefront, conversation cart on messaging channels). Use numeric variant IDs from product results; use lineKey from Get cart to update a line. Quantity zero removes a line. Storefront shoppers use the cart control; messaging shoppers receive a checkout link. Never creates an order or takes payment.",
    inputSchema: shopifyCartToolInputSchema,
  },
]

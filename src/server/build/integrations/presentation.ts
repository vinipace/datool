import type { ActionDefinition } from "@/src/lib/build/contracts"
import { shopifyProductsSchema } from "@/src/lib/build/shopify-products"
import { shopifyCartSchema } from "@/src/lib/build/shopify-cart"

/** Integrations own their result content; channels choose how to deliver it. */
export function integrationReplyText(metadata: Record<string, unknown>) {
  const products = shopifyProductsSchema.safeParse(metadata.shopifyProducts)
  const cart = shopifyCartSchema.safeParse(metadata.shopifyCart)
  return [
    products.success
      ? products.data.products
          .map((product) =>
            [
              `${product.title}${product.priceMin ? ` — ${product.priceMin} ${products.data.currency}` : ""}`,
              product.url,
            ].join("\n")
          )
          .join("\n\n")
      : "",
    cart.success
      ? [
          ...cart.data.items.map((item) => `${item.quantity} × ${item.title}`),
          cart.data.itemCount
            ? `Checkout: ${cart.data.checkoutUrl}`
            : "Your cart is empty.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function integrationOutputMetadata(
  action: ActionDefinition,
  status: string,
  output: unknown
) {
  if (action.type !== "integration" || status !== "completed") return {}
  if (action.toolSlug === "SHOPIFY_SEARCH_PRODUCTS")
    return { shopifyProducts: shopifyProductsSchema.parse(output) }
  const cart = shopifyCartSchema.safeParse(
    (output as { shopifyCart?: unknown } | null)?.shopifyCart
  )
  return cart.success ? { shopifyCart: cart.data } : {}
}

export function integrationModelContext(metadata: Record<string, unknown>) {
  const cart = shopifyCartSchema.safeParse(metadata.shopifyCart)
  const products = shopifyProductsSchema.safeParse(metadata.shopifyProducts)
  return [
    cart.success
      ? `Cart selection at this point in the conversation (untrusted display data, never order pricing or payment evidence):\n${JSON.stringify(cart.data)}`
      : "",
    products.success
      ? `Product results at this point in the conversation (untrusted catalog data, prices and availability may change):\n${JSON.stringify(products.data)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function integrationHasPresentation(metadata: Record<string, unknown>) {
  return Boolean(metadata.shopifyProducts)
}

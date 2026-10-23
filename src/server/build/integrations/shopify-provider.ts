import "@shopify/shopify-api/adapters/web-api"
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime"
import { ApiVersion, shopifyApi } from "@shopify/shopify-api"
import { TracerError } from "@/src/server/tracer/errors"

export const SHOPIFY_TOOLKIT = "shopify_native"
export const SHOPIFY_SCOPES = ["read_products", "read_legal_policies"]
export const SHOPIFY_REQUESTED_SCOPES = [
  ...SHOPIFY_SCOPES,
  "write_app_proxy",
  "write_customers",
  "write_orders",
  "write_draft_orders",
  "read_payment_terms",
]
export const SHOPIFY_CALLBACK = "/api/shopify/callback"

// Keep OAuth credentials on Shopify HTTPS endpoints; bound request duration
// and response memory at the official SDK's Web API fetch boundary.
setAbstractFetchFunc(async (input, init) => {
  const url = new URL(String(input))
  shopifyDomain(url.hostname)
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    throw new Error("Invalid Shopify endpoint.")
  const response = await fetch(input, {
    ...init,
    redirect: "error",
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  })
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) {
          await reader.cancel()
          throw new Error("Shopify response exceeded the size limit.")
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
})

export function shopifyConfigured() {
  return Boolean(
    process.env.DATOOL_SHOPIFY_CLIENT_ID &&
    process.env.DATOOL_SHOPIFY_CLIENT_SECRET
  )
}

export function shopifyOrigin() {
  const url = new URL(process.env.BETTER_AUTH_URL || "https://invalid.local")
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname === "invalid.local"
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Configure the HTTPS Datool URL before connecting Shopify."
    )
  return url.origin
}

export function shopifyDomain(value: string) {
  const shop = value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "")
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || shop.length > 253)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Enter your store's myshopify.com address, such as example.myshopify.com."
    )
  return shop
}

export function nativeShopify() {
  if (!shopifyConfigured())
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify needs administrator setup before a store can be connected."
    )
  const origin = new URL(shopifyOrigin())
  return shopifyApi({
    apiKey: process.env.DATOOL_SHOPIFY_CLIENT_ID!,
    apiSecretKey: process.env.DATOOL_SHOPIFY_CLIENT_SECRET!,
    apiVersion: ApiVersion.October26,
    // Keep catalog-only installations usable; individual commerce actions
    // enforce their additional grants and require a merchant reconnect.
    scopes: SHOPIFY_REQUESTED_SCOPES,
    hostName: origin.host,
    hostScheme: "https",
    isEmbeddedApp: false,
    // Never emit OAuth cookies, codes, credentials or provider response bodies.
    logger: { log: () => undefined },
  })
}

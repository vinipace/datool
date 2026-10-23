import { z } from "zod"

const quantity = z.number().int().min(0).max(99)
const variantId = z.string().regex(/^[1-9][0-9]{0,15}$/)
export const shopifyCartUpdateSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("add"),
      items: z
        .array(z.object({ variantId, quantity: quantity.min(1) }).strict())
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set"),
      lineKey: z.string().min(1).max(256),
      quantity,
    })
    .strict(),
])
export const shopifyCartCommandSchema = z.union([
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({ operation: z.literal("complete_order"), snapshotId: z.uuid() })
    .strict(),
  shopifyCartUpdateSchema,
])
export type ShopifyCartCommand = z.infer<typeof shopifyCartCommandSchema>

export const shopifyPurchaseSnapshotSchema = z
  .object({
    id: z.uuid(),
    expiresAt: z.number().int(),
  })
  .strict()
export const shopifyCartCleanupSchema = z
  .object({
    operationId: z.uuid(),
    snapshotId: z.uuid(),
    expiresAt: z.number().int(),
  })
  .strict()

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  })
export const shopifyCartSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    totalPrice: money,
    itemCount: z.number().int().min(0).max(100_000),
    items: z
      .array(
        z
          .object({
            lineKey: z.string().min(1).max(256),
            variantId,
            title: z.string().max(300),
            quantity: z.number().int().min(0).max(100_000),
            finalLinePrice: money,
            url: httpsUrl,
          })
          .strict()
      )
      .max(100),
    truncated: z.boolean(),
    // Older widget versions cannot prove that custom options were preserved.
    requiresStoreCheckout: z.boolean().optional(),
    // Only a reference to the browser's private cart snapshot crosses the bridge.
    purchaseSnapshot: shopifyPurchaseSnapshotSchema.optional(),
    cartUrl: httpsUrl,
    checkoutUrl: httpsUrl,
  })
  .strict()
export type ShopifyCart = z.infer<typeof shopifyCartSchema>

export const shopifyCartResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("completed"), cart: shopifyCartSchema })
    .strict(),
  z
    .object({
      status: z.enum(["failed", "uncertain"]),
      message: z.string().max(500),
    })
    .strict(),
])
export type ShopifyCartResult = z.infer<typeof shopifyCartResultSchema>

export function isShopifyCartTool(slug: string) {
  return slug === "SHOPIFY_GET_CART" || slug === "SHOPIFY_UPDATE_CART"
}

/** Browser cart data is a display snapshot, never trusted order pricing or payment evidence. */
export function requestShopifyCart(
  origin: string,
  command: ShopifyCartCommand,
  operationId: string,
  visitorId: string,
  expiresAt: number
): Promise<ShopifyCartResult> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const finish = () => {
      clearTimeout(timeout)
      window.removeEventListener("message", receive)
    }
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== origin ||
        event.data?.type !== "datool:shopify:cart-response" ||
        event.data.requestId !== requestId
      )
        return
      finish()
      const result = shopifyCartResultSchema.safeParse(event.data.result)
      if (result.success) resolve(result.data)
      else
        reject(
          new Error(
            "The store returned an invalid cart response. Open your cart to check its contents."
          )
        )
    }
    const timeout = setTimeout(() => {
      finish()
      reject(
        new Error(
          "The cart response timed out. Check your cart before trying again."
        )
      )
    }, 30_000)
    window.addEventListener("message", receive)
    window.parent.postMessage(
      {
        type: "datool:shopify:cart-request",
        requestId,
        operationId,
        visitorId,
        expiresAt,
        command,
      },
      origin
    )
  })
}

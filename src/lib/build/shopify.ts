import { z } from "zod"

/** Merchant configuration is saved with the action, never supplied by the model. */
export const shopifyActionSettingsSchema = z
  .object({
    requireHumanApproval: z.boolean().default(false),
    excludeOutOfStock: z.boolean().default(false),
    allowedOrderTags: z
      .array(z.string().trim().min(1).max(100))
      .max(30)
      .default([]),
    paymentMethod: z
      .enum(["online", "cash_on_delivery", "free"])
      .default("online"),
    orderSource: z.enum(["cart", "items"]).default("items"),
    shippingPhone: z.enum(["required", "optional", "omit"]).default("optional"),
    orderTags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    orderNote: z.string().max(1000).default(""),
    returnWindowDays: z.number().int().min(1).max(365).nullable().default(30),
    allowExchanges: z.boolean().default(false),
  })
  .strict()

export type ShopifyActionSettings = z.infer<typeof shopifyActionSettingsSchema>

const confirmationActions = new Set([
  "SHOPIFY_UPDATE_PROFILE",
  "SHOPIFY_UPDATE_ADDRESS",
  "SHOPIFY_ACTIVATE_ACCOUNT",
  "SHOPIFY_CREATE_ORDER",
  "SHOPIFY_RETURN_OR_EXCHANGE",
])

export function shopifyActionNeedsConfirmation(slug: string) {
  return confirmationActions.has(slug)
}

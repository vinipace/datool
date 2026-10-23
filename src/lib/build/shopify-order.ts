import { z } from "zod"

export const shopifyAddressSchema = z
  .object({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    address1: z.string().trim().min(1).max(200),
    address2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    provinceCode: z.string().trim().max(10).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().trim().max(20).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .optional(),
  })
  .strict()

const items = z
  .array(
    z
      .object({
        variantId: z.string().regex(/^[1-9][0-9]{0,15}$/),
        quantity: z.number().int().min(1).max(99),
      })
      .strict()
  )
  .min(1)
  .max(100)

/** Prices, payment mode, customer identity and merchant tags are never model arguments. */
export const shopifyOrderInputSchema = z
  .object({
    items: items.optional(),
    email: z.email().max(254),
    shippingAddress: shopifyAddressSchema.optional(),
    billingAddress: shopifyAddressSchema.optional(),
    shippingRateHandle: z.string().min(1).max(2048).optional(),
    discountCodes: z.array(z.string().trim().min(1).max(100)).max(5).optional(),
  })
  .strict()
export type ShopifyOrderInput = z.infer<typeof shopifyOrderInputSchema>

const money = z
  .object({
    amount: z
      .string()
      .max(40)
      .regex(/^\d+(?:\.\d+)?$/),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
export const shopifyOrderQuoteSchema = z
  .object({
    operationId: z.uuid(),
    expiresAt: z.number().int(),
    customerId: z.string().nullable(),
    input: shopifyOrderInputSchema.extend({ items }),
    paymentMethod: z.enum(["online", "cash_on_delivery", "free"]),
    items: z
      .array(z.object({ title: z.string(), quantity: z.number().int() }))
      .max(100),
    shippingTitle: z.string().nullable(),
    subtotal: money,
    shipping: money,
    tax: money,
    total: money,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ShopifyOrderQuote = z.infer<typeof shopifyOrderQuoteSchema>

export function shopifyOrderSummary(quote: ShopifyOrderQuote) {
  const moneyText = (value: ShopifyOrderQuote["total"]) =>
    `${value.currencyCode} ${value.amount}`
  return [
    ...quote.items.map((item) => `${item.quantity} × ${item.title}`),
    `Items: ${moneyText(quote.subtotal)}`,
    `Shipping${quote.shippingTitle ? ` (${quote.shippingTitle})` : ""}: ${moneyText(quote.shipping)}`,
    `Tax: ${moneyText(quote.tax)}`,
    `Total: ${moneyText(quote.total)}`,
    quote.paymentMethod === "online"
      ? "Pay through Shopify checkout. This does not mark the order as paid."
      : quote.paymentMethod === "free"
        ? "Free order. No payment will be collected."
        : "Cash on delivery. Payment remains outstanding.",
    `Contact: ${quote.input.email}`,
    ...(quote.input.shippingAddress
      ? [
          `Deliver to: ${Object.values(quote.input.shippingAddress).filter(Boolean).join(", ")}`,
        ]
      : []),
  ].join("\n")
}

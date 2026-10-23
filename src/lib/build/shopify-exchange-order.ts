import { z } from "zod"
import {
  shopifyOrderInputSchema,
  shopifyOrderQuoteSchema,
} from "./shopify-order"
import {
  shopifyReturnInputSchema,
  shopifyReturnQuoteSchema,
} from "./shopify-return"

/** Order proof and replacement contact are separate; neither selects an authenticated customer. */
export const shopifyExchangeOrderInputSchema = shopifyReturnInputSchema.extend({
  replacements: shopifyOrderInputSchema.shape.items.unwrap(),
  contactEmail: shopifyOrderInputSchema.shape.email,
  shippingAddress: shopifyOrderInputSchema.shape.shippingAddress,
  billingAddress: shopifyOrderInputSchema.shape.billingAddress,
  shippingRateHandle: shopifyOrderInputSchema.shape.shippingRateHandle,
  fault: z.enum(["merchant", "customer"]),
})

export const shopifyExchangeOrderQuoteSchema = z
  .object({
    operationId: z.uuid(),
    expiresAt: z.number().int(),
    input: shopifyExchangeOrderInputSchema,
    returned: shopifyReturnQuoteSchema.extend({
      credit: shopifyReturnQuoteSchema.shape.credit.unwrap(),
    }),
    replacement: shopifyOrderQuoteSchema,
    settlement: shopifyReturnQuoteSchema.shape.settlement,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ShopifyExchangeOrderQuote = z.infer<
  typeof shopifyExchangeOrderQuoteSchema
>

export function shopifyExchangeOrderSummary(quote: ShopifyExchangeOrderQuote) {
  const money = (value: { amount: string; currencyCode: string }) =>
    `${value.currencyCode} ${value.amount}`
  return [
    `Replacement exchange for ${quote.returned.orderName}`,
    ...quote.returned.items.map(
      (item) => `Return: ${item.quantity} × ${item.title}`
    ),
    ...quote.replacement.items.map(
      (item) => `Receive: ${item.quantity} × ${item.title}`
    ),
    `Reason: ${quote.input.reason}`,
    `Responsibility: ${quote.input.fault === "merchant" ? "Merchant fault; free replacement shipping" : "Customer request; paid replacement shipping"}`,
    `Return credit after fees: ${money(quote.returned.credit)}`,
    `Replacement items: ${money(quote.replacement.subtotal)}`,
    `Replacement shipping: ${money(quote.replacement.shipping)}`,
    `Replacement tax: ${money(quote.replacement.tax)}`,
    quote.settlement.direction === "even"
      ? "No payment difference."
      : `${quote.settlement.direction === "collect" ? "Additional payment" : "Refund difference"}: ${money(quote.settlement)}`,
    `Replacement contact: ${quote.input.contactEmail}`,
    ...(quote.input.shippingAddress
      ? [
          `Deliver to: ${Object.values(quote.input.shippingAddress).filter(Boolean).join(", ")}`,
        ]
      : []),
    "A teammate must verify the responsibility, items and balance before any exchange is placed.",
    "Preview only: this exchange cannot be placed yet.",
  ].join("\n")
}

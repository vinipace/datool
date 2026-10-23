import { z } from "zod"
import { orderLookupSchema } from "./shopify-order"

export const shopifyReturnLookupSchema = orderLookupSchema
  .omit({ after: true })
  .extend({
    orderId: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/),
  })
export const shopifyReturnInputSchema = shopifyReturnLookupSchema.extend({
  items: z
    .array(
      z
        .object({
          fulfillmentLineItemId: z
            .string()
            .regex(/^gid:\/\/shopify\/FulfillmentLineItem\/[1-9][0-9]*$/),
          quantity: z.number().int().min(1).max(250),
        })
        .strict()
    )
    .min(1)
    .max(100),
  replacements: z
    .array(
      z
        .object({
          variantId: z.string().regex(/^[1-9][0-9]{0,15}$/),
          quantity: z.number().int().min(1).max(250),
        })
        .strict()
    )
    .max(100)
    .default([]),
  reason: z.string().trim().min(1).max(180),
})

export const shopifyReturnResumeInputSchema = z
  .object({ operationId: z.uuid() })
  .strict()
export const shopifyReturnActionInputSchema = z.union([
  shopifyReturnInputSchema,
  shopifyReturnResumeInputSchema,
])

const money = z
  .object({
    amount: z
      .string()
      .max(40)
      .regex(/^\d+(?:\.\d+)?$/),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
export const shopifyReturnQuoteSchema = z
  .object({
    operationId: z.uuid(),
    expiresAt: z.number().int(),
    customerId: z.string().nullable(),
    orderName: z.string(),
    input: shopifyReturnInputSchema,
    items: z
      .array(z.object({ title: z.string(), quantity: z.number().int() }))
      .max(100),
    replacements: z
      .array(z.object({ title: z.string(), quantity: z.number().int() }))
      .max(100),
    credit: money.optional(),
    replacementTotal: money.optional(),
    resume: z
      .object({
        returnId: z.string().regex(/^gid:\/\/shopify\/Return\/[1-9][0-9]*$/),
        revision: z.number().int().nonnegative(),
        requireHumanApproval: z.boolean(),
      })
      .strict()
      .optional(),
    settlement: z
      .object({
        direction: z.enum(["refund", "collect", "even"]),
        ...money.shape,
      })
      .strict(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ShopifyReturnInput = z.infer<typeof shopifyReturnInputSchema>
export type ShopifyReturnQuote = z.infer<typeof shopifyReturnQuoteSchema>

export const shopifyExchangeHoldPlanSchema = z.object({
  returnId: z.string(),
  orders: z
    .array(
      z.object({
        id: z.string(),
        holdIds: z.array(z.string()).min(1),
        items: z
          .array(
            z.object({ id: z.string(), quantity: z.number().int().positive() })
          )
          .min(1),
      })
    )
    .min(1),
})
export type ShopifyExchangeHoldPlan = z.infer<
  typeof shopifyExchangeHoldPlanSchema
>

export function shopifyReturnSummary(quote: ShopifyReturnQuote) {
  return [
    ...(quote.resume
      ? ["Continue the existing return. No new return will be created."]
      : []),
    `Order ${quote.orderName}`,
    ...quote.items.map((item) => `Return: ${item.quantity} × ${item.title}`),
    ...quote.replacements.map(
      (item) => `Receive: ${item.quantity} × ${item.title}`
    ),
    `Reason: ${quote.input.reason}`,
    quote.settlement.direction === "even"
      ? "No payment difference."
      : `${quote.settlement.direction === "refund" ? "Refund" : "Additional payment"}: ${quote.settlement.currencyCode} ${quote.settlement.amount}`,
    quote.resume
      ? "Shopify will recheck the existing items, replacement stock and balance before continuing."
      : "Shopify will recheck eligibility and amounts before processing this return.",
  ].join("\n")
}

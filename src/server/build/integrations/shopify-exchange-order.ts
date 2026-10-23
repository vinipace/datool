import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyExchangeOrderInputSchema,
  shopifyExchangeOrderQuoteSchema,
} from "@/src/lib/build/shopify-exchange-order"
import type { ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import { prepareShopifyReturn, totalShopifyMoney } from "./shopify-return-quote"
import { prepareShopifyOrder } from "./shopify-order-create"

/** Read-only preflight. Original-order ownership is checked before replacement catalog/address reads. */
export async function prepareShopifyExchangeOrder(
  input: unknown,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operationId: string = randomUUID()
) {
  const args = shopifyExchangeOrderInputSchema.parse(input)
  const returned = shopifyExchangeOrderQuoteSchema.shape.returned.parse(
    await prepareShopifyReturn(
      {
        orderId: args.orderId,
        orderNumber: args.orderNumber,
        email: args.email,
        phone: args.phone,
        items: args.items,
        replacements: [],
        reason: args.reason,
      },
      shopper,
      { ...settings, returnWindowDays: null },
      graphql
    )
  )
  const { quote: replacement } = await prepareShopifyOrder(
    {
      items: args.replacements,
      email: args.contactEmail,
      shippingAddress: args.shippingAddress,
      billingAddress: args.billingAddress,
      shippingRateHandle: args.shippingRateHandle,
    },
    shopper,
    { ...settings, paymentMethod: "online", orderSource: "items" },
    graphql,
    operationId,
    {
      freeShipping: args.fault === "merchant",
    }
  )
  const balance = totalShopifyMoney(
    [{ value: replacement.total }, { value: returned.credit, subtract: true }],
    replacement.total.currencyCode
  )
  const settlement = {
    direction:
      balance.amount === "0"
        ? "even"
        : balance.amount.startsWith("-")
          ? "refund"
          : "collect",
    amount: balance.amount.replace(/^-/, ""),
    currencyCode: balance.currencyCode,
  }
  const normalizedInput = {
    ...args,
    shippingAddress: replacement.input.shippingAddress,
    billingAddress: replacement.input.billingAddress,
    shippingRateHandle: replacement.input.shippingRateHandle,
  }
  return shopifyExchangeOrderQuoteSchema.parse({
    operationId,
    expiresAt: Math.min(returned.expiresAt, replacement.expiresAt),
    input: normalizedInput,
    returned,
    replacement,
    settlement,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          input: normalizedInput,
          returned: returned.fingerprint,
          replacement: replacement.fingerprint,
          settings,
        })
      )
      .digest("hex"),
  })
}

export const shopifyExchangeOrderTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_CREATE_EXCHANGE_ORDER",
    name: "Create replacement exchange",
    description:
      "Prepare a separate replacement-order exchange for human review. Verify the original order using the signed-in account or its number and checkout email/phone. Collect replacement variants, contact email, delivery address, reason and whether this is merchant fault or a customer request. Merchant-fault replacement delivery is free. There is no delivery-age window. A replacement is required; use Return or exchange items for a plain refund. Always requires teammate approval. Execution is not yet available in this draft release; approval cannot place an exchange.",
    inputSchema: z.toJSONSchema(shopifyExchangeOrderInputSchema, {
      target: "draft-7",
    }),
  },
]

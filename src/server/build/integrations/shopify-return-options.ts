import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { shopifyReturnLookupSchema } from "@/src/lib/build/shopify-return"
import { TracerError } from "@/src/server/tracer/errors"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import { canAccessShopifyOrder } from "./shopify-orders"
import type { ShopifyShopper } from "./shopify-identity"

export const RETURN_ORDER_OWNER = `#graphql
 query DatoolReturnOrder($id: ID!) {
   order(id: $id) {
     id name email phone customer { id } shippingAddress { phone }
     currencyCode presentmentCurrencyCode
   }
 }
`
const returnLines = `nodes { quantity fulfillmentLineItem { id lineItem { id name variant { id } } } }
 pageInfo { hasNextPage endCursor }`
export const RETURNABLE_FULFILLMENTS = `#graphql
 query DatoolReturnableFulfillments($orderId: ID!, $after: String) {
   returnableFulfillments(orderId: $orderId, first: 20, after: $after) {
     nodes {
       id fulfillment { id deliveredAt }
       returnableFulfillmentLineItems(first: 100) { ${returnLines} }
     }
     pageInfo { hasNextPage endCursor }
   }
 }
`
export const RETURNABLE_LINES = `#graphql
 query DatoolReturnableLines($id: ID!, $after: String) {
   returnableFulfillment(id: $id) {
     id returnableFulfillmentLineItems(first: 100, after: $after) { ${returnLines} }
   }
 }
`

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}
type ReturnableLine = {
  quantity: number
  fulfillmentLineItem: {
    id: string
    lineItem: { id: string; name: string; variant: { id: string } | null }
  }
}
type ReturnableFulfillment = {
  id: string
  fulfillment: { id: string; deliveredAt: string | null }
  returnableFulfillmentLineItems: Page<ReturnableLine>
}
export type ReturnOption = {
  fulfillmentLineItemId: string
  lineItemId: string
  variantId: string | null
  title: string
  quantity: number
  deliveredAt: string | null
}

/** Both reads and mutations verify the order before requesting its returnable lines. */
export async function getShopifyReturnOptions(
  input: unknown,
  shopper: ShopifyShopper,
  graphql: ShopifyGraphqlClient
) {
  const args = shopifyReturnLookupSchema.parse(input)
  if (
    !shopper.customerId &&
    (!args.orderNumber || (!args.email && !args.phone))
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Provide the order number and its checkout email or phone, or sign in to your store account."
    )
  const data = await shopifyData<{
    order: {
      id: string
      name: string
      email: string | null
      phone: string | null
      customer: { id: string } | null
      shippingAddress: { phone: string | null } | null
      currencyCode: string
      presentmentCurrencyCode: string
    } | null
  }>(graphql, RETURN_ORDER_OWNER, { id: args.orderId })
  const order = data.order
  if (
    !order ||
    order.id !== args.orderId ||
    !canAccessShopifyOrder(order, args, shopper)
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "No matching accessible order was found."
    )
  const items: ReturnOption[] = []
  let after: string | null = null
  const seen = new Set<string>()
  do {
    const page: { returnableFulfillments: Page<ReturnableFulfillment> } =
      await shopifyData(graphql, RETURNABLE_FULFILLMENTS, {
        orderId: order.id,
        after,
      })
    for (const fulfillment of page.returnableFulfillments.nodes) {
      let lines = fulfillment.returnableFulfillmentLineItems
      const lineCursors = new Set<string>()
      let lineCursor: string | null
      do {
        for (const line of lines.nodes) {
          if (line.quantity <= 0) continue
          items.push({
            fulfillmentLineItemId: line.fulfillmentLineItem.id,
            lineItemId: line.fulfillmentLineItem.lineItem.id,
            variantId: line.fulfillmentLineItem.lineItem.variant?.id ?? null,
            title: line.fulfillmentLineItem.lineItem.name,
            quantity: line.quantity,
            deliveredAt: fulfillment.fulfillment.deliveredAt,
          })
        }
        lineCursor = nextCursor(lines.pageInfo, lineCursors)
        if (!lineCursor) break
        const next = await shopifyData<{
          returnableFulfillment: ReturnableFulfillment | null
        }>(graphql, RETURNABLE_LINES, { id: fulfillment.id, after: lineCursor })
        if (next.returnableFulfillment?.id !== fulfillment.id)
          throw new TracerError(
            "VALIDATION_ERROR",
            "Shopify changed the returnable items. Check the order again."
          )
        lines = next.returnableFulfillment.returnableFulfillmentLineItems
      } while (lineCursor)
    }
    after = nextCursor(page.returnableFulfillments.pageInfo, seen)
  } while (after)
  return {
    status: items.length ? "found" : "not_returnable",
    orderId: order.id,
    orderName: order.name,
    currencyCode: order.presentmentCurrencyCode,
    items,
    message: items.length
      ? undefined
      : "Shopify has no items available to return on this order.",
  }
}

function nextCursor(info: Page<unknown>["pageInfo"], seen: Set<string>) {
  if (!info.hasNextPage) return null
  if (!info.endCursor || seen.has(info.endCursor))
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify could not provide the complete returnable items. Check the order again."
    )
  seen.add(info.endCursor)
  return info.endCursor
}

export const shopifyReturnReadTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_GET_RETURN_OPTIONS",
    name: "Find returnable items",
    description:
      "Read the items and quantities Shopify still allows to be returned from an accessible order. Use the order ID from Find orders and tracking. Guests must provide the matching order number and checkout email or phone; never supply a customer ID. Delivery dates are included for the merchant's return-window policy. This read does not approve a return or issue a refund.",
    inputSchema: z.toJSONSchema(shopifyReturnLookupSchema, {
      target: "draft-7",
    }),
  },
]

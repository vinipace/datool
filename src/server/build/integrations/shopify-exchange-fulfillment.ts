import { TracerError } from "@/src/server/tracer/errors"
import type { ShopifyExchangeHoldPlan } from "@/src/lib/build/shopify-return"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import type {
  ShopifyOperationStore,
  ShopifyReturnOperation,
} from "./shopify-operation-store"
import { canAccessShopifyOrder } from "./shopify-orders"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"
import { matchesReturnLines, sameShopifyMoney } from "./shopify-return-record"
import {
  CHECK_CREATED_RETURN,
  type ReturnRecord,
} from "./shopify-return-status"

export const EXCHANGE_FULFILLMENT = `#graphql
 query DatoolExchangeFulfillment($id: ID!, $after: String) {
   return(id: $id) {
     id
     exchangeLineItems(first: 100) {
       nodes { quantity processedQuantity lineItems { id quantity } }
       pageInfo { hasNextPage }
     }
     order {
       id
       fulfillmentOrders(first: 2, after: $after) {
         nodes {
           id status
           fulfillmentHolds { id reason heldByRequestingApp heldByApp { id } }
           lineItems(first: 100) {
             nodes { totalQuantity remainingQuantity lineItem { id } }
             pageInfo { hasNextPage }
           }
         }
         pageInfo { hasNextPage endCursor }
       }
     }
   }
 }
`
export const RELEASE_EXCHANGE_HOLDS = `#graphql
 mutation DatoolReleaseExchangeHolds($id: ID!, $holdIds: [ID!]!, $externalId: String!) {
   fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds, externalId: $externalId) {
     fulfillmentOrder { id status fulfillmentHolds { id } }
     userErrors { field message code }
   }
 }
`

type Hold = {
  id: string
  reason: string
  heldByRequestingApp: boolean
  heldByApp: { id: string } | null
}
type FulfillmentOrder = {
  id: string
  status: string
  fulfillmentHolds: Hold[]
  lineItems: {
    nodes: Array<{
      totalQuantity: number
      remainingQuantity: number
      lineItem: { id: string }
    }>
    pageInfo: { hasNextPage: boolean }
  }
}
type Snapshot = {
  return: {
    id: string
    exchangeLineItems: {
      nodes: Array<{
        quantity: number
        processedQuantity: number
        lineItems: Array<{ id: string; quantity: number }> | null
      }>
      pageInfo: { hasNextPage: boolean }
    }
    order: {
      id: string
      fulfillmentOrders: {
        nodes: FulfillmentOrder[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    }
  } | null
}
const review = (message: string) => ({
  fulfillmentStatus: "needs_review" as const,
  message,
})
const paymentHold = (hold: Hold) =>
  hold.reason === "AWAITING_PAYMENT" &&
  (hold.heldByRequestingApp || hold.heldByApp === null)

async function paymentState(
  operation: ShopifyReturnOperation,
  shopper: ShopifyShopper,
  graphql: ShopifyGraphqlClient
) {
  const { return: returned } = await shopifyData<{
    return: ReturnRecord | null
  }>(graphql, CHECK_CREATED_RETURN, { id: operation.returnId })
  const quote = operation.quote
  if (
    !returned ||
    returned.id !== operation.returnId ||
    returned.order.id !== quote.input.orderId ||
    !canAccessShopifyOrder(returned.order, quote.input, shopper) ||
    !["OPEN", "CLOSED"].includes(returned.status) ||
    !matchesReturnLines(returned, quote, true) ||
    returned.order.cancelledAt ||
    returned.transactions.pageInfo.hasNextPage ||
    returned.transactions.nodes.some((tx) => tx.kind === "REFUND")
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "The exchange's ownership, items or payment history changed. Its fulfillment holds require store-team review."
    )
  const order = returned.order
  const outstanding = order.totalOutstandingSet.presentmentMoney
  if (
    sameShopifyMoney(outstanding, { ...quote.settlement, amount: "0" }) &&
    order.fullyPaid &&
    order.displayFinancialStatus === "PAID"
  )
    return "paid"
  if (
    !order.fullyPaid &&
    ["PENDING", "PARTIALLY_PAID"].includes(
      order.displayFinancialStatus ?? ""
    ) &&
    sameShopifyMoney(outstanding, quote.settlement)
  )
    return "unpaid"
  return "unverified"
}

async function readFulfillment(
  operation: ShopifyReturnOperation,
  graphql: ShopifyGraphqlClient
) {
  const orders: FulfillmentOrder[] = []
  const cursors = new Set<string>()
  let after: string | null = null
  let items: Array<{ id: string; quantity: number }> = []
  // Keep nested line-item reads small; truncated pages can never authorize release.
  for (let page = 0; page < 100; page++) {
    const data: Snapshot = await shopifyData<Snapshot>(
      graphql,
      EXCHANGE_FULFILLMENT,
      { id: operation.returnId, after }
    )
    const returned: Snapshot["return"] = data.return
    if (
      !returned ||
      returned.id !== operation.returnId ||
      returned.order.id !== operation.quote.input.orderId ||
      returned.exchangeLineItems.pageInfo.hasNextPage
    )
      return null
    const lines = returned.exchangeLineItems.nodes
    if (
      !lines.length ||
      lines.some(
        (line) =>
          line.processedQuantity !== line.quantity ||
          !line.lineItems?.length ||
          line.lineItems.reduce((sum, item) => sum + item.quantity, 0) !==
            line.quantity
      )
    )
      return null
    const current = lines
      .flatMap((line) => line.lineItems!)
      .sort((a, b) => a.id.localeCompare(b.id))
    if (
      new Set(current.map((item) => item.id)).size !== current.length ||
      current.some((item) => item.quantity <= 0) ||
      (page > 0 && JSON.stringify(current) !== JSON.stringify(items))
    )
      return null
    items = current
    orders.push(...returned.order.fulfillmentOrders.nodes)
    const next = returned.order.fulfillmentOrders.pageInfo
    if (!next.hasNextPage) {
      if (new Set(orders.map((order) => order.id)).size !== orders.length)
        return null
      return { orders, items }
    }
    if (!next.endCursor || cursors.has(next.endCursor)) return null
    cursors.add(next.endCursor)
    after = next.endCursor
  }
  return null
}

function sameItems(
  order: FulfillmentOrder,
  items: Array<{ id: string; quantity: number }>
) {
  return (
    !order.lineItems.pageInfo.hasNextPage &&
    order.lineItems.nodes.length === items.length &&
    items.every((item) =>
      order.lineItems.nodes.some(
        (line) =>
          line.lineItem.id === item.id && line.totalQuantity === item.quantity
      )
    )
  )
}

/** Record before payment; afterward release only those immutable hold IDs. */
export async function reconcileShopifyExchangeFulfillment(
  operationId: string,
  shopper: ShopifyShopper,
  operations: ShopifyOperationStore,
  graphql: ShopifyGraphqlClient,
  beforeWrite?: () => Promise<void>
) {
  const operation = await operations.readReturn(operationId)
  if (
    !operation?.returnId ||
    operation.quote.settlement.direction !== "collect" ||
    !operation.quote.input.replacements.length ||
    !operation.settings.allowExchanges
  )
    return review("No approved payable exchange is available for this shopper.")
  const payment = await paymentState(operation, shopper, graphql)
  if (payment === "unverified")
    return {
      fulfillmentStatus: "payment_pending" as const,
      message: "Payment is not confirmed. No fulfillment hold was released.",
    }
  const snapshot = await readFulfillment(operation, graphql)
  if (!snapshot)
    return review(
      "The complete exchange fulfillment could not be verified. No hold was released; the store team must review it."
    )
  let plan = operation.holdPlan
  if (!plan) {
    if (payment === "paid")
      return review(
        "Payment is confirmed, but its original payment holds were not recorded before payment. The store team must review the existing holds."
      )
    const wanted = new Map(
      snapshot.items.map((item) => [item.id, item.quantity])
    )
    const found = new Map<string, number>()
    const planned: ShopifyExchangeHoldPlan["orders"] = []
    for (const order of snapshot.orders) {
      const lines = order.lineItems.nodes
      if (!lines.some((line) => wanted.has(line.lineItem.id))) continue
      if (
        order.status !== "ON_HOLD" ||
        order.lineItems.pageInfo.hasNextPage ||
        new Set(lines.map((line) => line.lineItem.id)).size !== lines.length ||
        lines.some(
          (line) =>
            !wanted.has(line.lineItem.id) ||
            line.totalQuantity <= 0 ||
            line.remainingQuantity !== line.totalQuantity
        )
      )
        return review(
          "The exchange shares or changed its fulfillment lines. The store team must review its holds."
        )
      const holds = order.fulfillmentHolds.filter(paymentHold)
      if (!holds.length)
        return review(
          "No attributable exchange payment hold was found. Other holds were preserved."
        )
      const items = lines.map((line) => ({
        id: line.lineItem.id,
        quantity: line.totalQuantity,
      }))
      for (const item of items)
        found.set(item.id, (found.get(item.id) ?? 0) + item.quantity)
      planned.push({
        id: order.id,
        holdIds: holds.map((hold) => hold.id),
        items,
      })
    }
    if (!planned.length)
      return {
        fulfillmentStatus: "routing_pending" as const,
        message:
          "Shopify has not exposed the exchange fulfillment yet. Check return again after routing completes.",
      }
    if ([...wanted].some(([id, quantity]) => found.get(id) !== quantity))
      return review(
        "Some exchange fulfillment is missing or outside the granted permissions. Reconnect Shopify with fulfillment permissions or ask the store team to review it."
      )
    plan = { returnId: operation.returnId, orders: planned }
    await operations.recordReturnHolds(operation, plan)
    return {
      fulfillmentStatus: "payment_required" as const,
      message:
        "The original exchange payment holds are recorded. They will be released only after Shopify confirms payment.",
    }
  }
  if (plan.returnId !== operation.returnId)
    return review("The recorded payment holds do not match this exchange.")
  if (payment !== "paid" || !beforeWrite)
    return {
      fulfillmentStatus: "payment_required" as const,
      message: "The recorded payment holds remain until payment is verified.",
    }
  let otherHolds = false
  for (const [index, target] of plan.orders.entries()) {
    // Refresh both ownership/payment and exact fulfillment membership before each write.
    const current =
      index === 0 ? snapshot : await readFulfillment(operation, graphql)
    const order = current?.orders.find((order) => order.id === target.id)
    if (
      !current ||
      !order ||
      current.orders.some(
        (candidate) =>
          !plan.orders.some((recorded) => recorded.id === candidate.id) &&
          candidate.lineItems.nodes.some((line) =>
            current.items.some((item) => item.id === line.lineItem.id)
          )
      ) ||
      !sameItems(order, target.items) ||
      target.items.some(
        (item) =>
          !current.items.some(
            (line) => line.id === item.id && line.quantity >= item.quantity
          )
      )
    )
      return review(
        "The exchange fulfillment changed. Remaining holds were preserved for store-team review."
      )
    const holds = order.fulfillmentHolds.filter((hold) =>
      target.holdIds.includes(hold.id)
    )
    if (
      holds.some((hold) => !paymentHold(hold)) ||
      (holds.length &&
        (order.status !== "ON_HOLD" ||
          order.lineItems.nodes.some(
            (line) => line.remainingQuantity !== line.totalQuantity
          )))
    )
      return review("A recorded hold changed. No further hold was released.")
    otherHolds ||= order.fulfillmentHolds.some(
      (hold) => !target.holdIds.includes(hold.id)
    )
    if (!holds.length) continue
    if ((await paymentState(operation, shopper, graphql)) !== "paid")
      return review(
        "Payment changed before hold release. Remaining holds were preserved."
      )
    const result = await shopifyMutation<{
      fulfillmentOrder: {
        id: string
        fulfillmentHolds: Array<{ id: string }>
      } | null
    }>(
      graphql,
      RELEASE_EXCHANGE_HOLDS,
      {
        id: order.id,
        holdIds: holds.map((hold) => hold.id),
        externalId: `datool-return-${operation.id}`,
      },
      "fulfillmentOrderReleaseHold",
      beforeWrite
    )
    if (
      !result.fulfillmentOrder ||
      result.fulfillmentOrder.id !== order.id ||
      result.fulfillmentOrder.fulfillmentHolds.some((hold) =>
        holds.some((target) => target.id === hold.id)
      )
    )
      throw new ShopifyWriteUncertainError()
    otherHolds ||= result.fulfillmentOrder.fulfillmentHolds.length > 0
  }
  return {
    fulfillmentStatus: "payment_holds_cleared" as const,
    message: otherHolds
      ? "The original exchange payment holds are cleared. Other fulfillment holds remain for the store team; replacements have not been marked shipped."
      : "The original exchange payment holds are cleared. The store can proceed with fulfillment; this does not mean the replacements shipped.",
  }
}

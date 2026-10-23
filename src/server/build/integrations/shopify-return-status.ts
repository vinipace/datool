import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import type { ShopifyOperationStore } from "./shopify-operation-store"
import { canAccessShopifyOrder } from "./shopify-orders"
import {
  matchesReturnLines,
  sameShopifyMoney,
  shopifyRefundStatus,
  type ReturnLines,
  type ReturnPage,
  type ReturnTransaction,
} from "./shopify-return-record"
import { type ShopifyMoney } from "./shopify-return-quote"

const inputSchema = z.object({ operationId: z.uuid().optional() }).strict()
const owner = `id name email phone customer { id } shippingAddress { phone }`
const money = `presentmentMoney { amount currencyCode }`

export const FIND_CREATED_RETURN = `#graphql
  query DatoolFindCreatedReturn($orderId: ID!, $after: String) {
    order(id: $orderId) {
      ${owner}
      returns(first: 5, after: $after) {
        nodes {
          id
          returnLineItems(first: 100) {
            nodes { ... on ReturnLineItem { returnReasonNote } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`
export const CHECK_CREATED_RETURN = `#graphql
  query DatoolCheckCreatedReturn($id: ID!) {
    return(id: $id) {
      id status
      order {
        ${owner}
        cancelledAt displayFinancialStatus fullyPaid
        totalOutstandingSet { ${money} }
        paymentCollectionDetails { additionalPaymentCollectionUrl }
      }
      returnLineItems(first: 100) {
        nodes { id quantity processedQuantity ... on ReturnLineItem { fulfillmentLineItem { id } } }
        pageInfo { hasNextPage }
      }
      exchangeLineItems(first: 100) {
        nodes { id quantity processedQuantity variantId }
        pageInfo { hasNextPage }
      }
      transactions(first: 100) {
        nodes { id kind status amountSet { ${money} } }
        pageInfo { hasNextPage }
      }
    }
  }
`

type OrderOwner = Parameters<typeof canAccessShopifyOrder>[0] & { id: string }
export type ReturnRecord = ReturnLines & {
  status: string
  order: OrderOwner & {
    cancelledAt: string | null
    displayFinancialStatus: string | null
    fullyPaid: boolean
    totalOutstandingSet: { presentmentMoney: ShopifyMoney }
    paymentCollectionDetails: { additionalPaymentCollectionUrl: string | null }
  }
  transactions: ReturnPage<ReturnTransaction>
}

/** Recover the original return from Shopify. Never replay creation, refund or invoice writes. */
export async function checkShopifyReturn(
  input: unknown,
  shopper: ShopifyShopper,
  operations: ShopifyOperationStore,
  graphql: ShopifyGraphqlClient
) {
  const { operationId } = inputSchema.parse(input)
  const operation = await operations.readReturn(operationId)
  if (!operation)
    return {
      status: "not_found",
      message:
        "There is no return to check for this store session and conversation.",
    }
  if (operation.status === "failed")
    return {
      status: "not_created",
      operationId: operation.id,
      message:
        "Shopify rejected this attempt before a return was created. Review the details before requesting a new return.",
    }
  if (
    ["pending", "return_created", "processing"].includes(operation.status) &&
    operation.updatedAt.getTime() > Date.now() - 120_000
  )
    return {
      status: "processing",
      operationId: operation.id,
      message:
        "This return may still be processing. Check return again shortly; do not submit another refund or exchange.",
    }
  const quote = operation.quote
  const review = (message: string) => ({
    status: "needs_review" as const,
    operationId: operation.id,
    message,
  })
  const inaccessible = () =>
    review(
      "The existing return could not be verified for this shopper. The store team must review it before continuing."
    )
  const ownsOrder = (order: OrderOwner) =>
    order.id === quote.input.orderId &&
    canAccessShopifyOrder(order, quote.input, shopper)

  let returnId = operation.returnId
  if (!returnId) {
    // The original write can finish even if its response or our ID save failed.
    // Search the owned order, requiring the complete marker on every return line.
    const marker = `${quote.input.reason}\nDatool:${operation.id}`
    const matches = new Set<string>()
    const cursors = new Set<string>()
    let after: string | null = null
    let complete = false
    for (let page = 0; page < 20; page++) {
      const data: {
        order:
          | (OrderOwner & {
              returns: ReturnPage<{
                id: string
                returnLineItems: ReturnPage<{ returnReasonNote?: string }>
              }> & {
                pageInfo: { hasNextPage: boolean; endCursor: string | null }
              }
            })
          | null
      } = await shopifyData(graphql, FIND_CREATED_RETURN, {
        orderId: quote.input.orderId,
        after,
      })
      if (!data.order || !ownsOrder(data.order)) return inaccessible()
      for (const candidate of data.order.returns.nodes) {
        if (
          !candidate.returnLineItems.pageInfo.hasNextPage &&
          candidate.returnLineItems.nodes.length === quote.input.items.length &&
          candidate.returnLineItems.nodes.every(
            (line) => line.returnReasonNote === marker
          )
        )
          matches.add(candidate.id)
      }
      if (matches.size > 1) break
      const next = data.order.returns.pageInfo
      if (!next.hasNextPage) {
        complete = true
        break
      }
      if (!next.endCursor || cursors.has(next.endCursor)) break
      cursors.add(next.endCursor)
      after = next.endCursor
    }
    if (!complete || matches.size !== 1)
      return review(
        "Shopify has not returned one uniquely matching return. This does not prove the attempt failed. The store team must inspect it before another return or refund is attempted."
      )
    returnId = [...matches][0]
  }
  const data = await shopifyData<{ return: ReturnRecord | null }>(
    graphql,
    CHECK_CREATED_RETURN,
    { id: returnId }
  )
  const returned = data.return
  if (!returned || returned.id !== returnId || !ownsOrder(returned.order))
    return inaccessible()
  if (!["OPEN", "CLOSED"].includes(returned.status))
    return review(
      "Shopify changed the return's status. The store team must review it before continuing; no return or refund was repeated."
    )
  if (!matchesReturnLines(returned, quote, true)) {
    if (matchesReturnLines(returned, quote, false)) {
      const result = {
        ...review(
          "The original return exists, but Shopify has not confirmed processing its items. The store team must review that return before continuing. No new return, refund or invoice was sent."
        ),
        returnId,
        orderId: quote.input.orderId,
        returnStatus: returned.status,
      }
      // A stale provider read must not downgrade a previously confirmed outcome.
      if (operation.status === "return_processed") return result
      return operations.finishReturn(operation.id, result, operation.revision)
    }
    return review(
      "The return's items or processed quantities differ from the approved request. The store team must review it before continuing."
    )
  }
  if (returned.transactions.pageInfo.hasNextPage)
    return review(
      "The return has more payment transactions than can be verified here. The store team must check the complete payment history."
    )
  const refunds = returned.transactions.nodes.filter(
    (tx) => tx.kind === "REFUND"
  )
  let paymentStatus:
    | "refunded"
    | "refund_pending"
    | "payment_required"
    | "payment_pending"
    | "paid"
    | "no_payment_difference" = "no_payment_difference"
  let paymentUrl: string | undefined
  if (quote.settlement.direction === "refund") {
    const refundStatus = shopifyRefundStatus(
      returned.transactions,
      quote.settlement
    )
    if (!refundStatus)
      return review(
        "Shopify processed the items but has not confirmed the expected refund. The store team must inspect the transactions before another refund attempt."
      )
    paymentStatus = refundStatus
  } else if (quote.settlement.direction === "collect") {
    const order = returned.order
    const outstanding = order.totalOutstandingSet.presentmentMoney
    const zero = sameShopifyMoney(outstanding, {
      amount: "0",
      currencyCode: quote.settlement.currencyCode,
    })
    if (order.cancelledAt || refunds.length)
      return review(
        "The exchange order was canceled or has refund activity. The store team must review its payment and fulfillment status."
      )
    if (zero && order.fullyPaid && order.displayFinancialStatus === "PAID") {
      paymentStatus = "paid"
    } else if (zero || order.displayFinancialStatus === "AUTHORIZED") {
      paymentStatus = "payment_pending"
    } else if (
      !order.fullyPaid &&
      ["PENDING", "PARTIALLY_PAID"].includes(
        order.displayFinancialStatus ?? ""
      ) &&
      sameShopifyMoney(outstanding, quote.settlement)
    ) {
      paymentStatus = "payment_required"
      const url = order.paymentCollectionDetails.additionalPaymentCollectionUrl
      if (url && isSafeHttpUrl(url) && new URL(url).protocol === "https:")
        paymentUrl = url
    } else {
      return review(
        "The exchange's outstanding balance differs from the approved amount. The store team must review it before collecting another payment."
      )
    }
  } else if (refunds.length) {
    return review(
      "This exchange was approved without a payment difference, but Shopify reports refund activity. The store team must review its transactions."
    )
  }
  const messages = {
    refunded:
      "Shopify confirmed this return's refund as successful. No refund was repeated.",
    refund_pending:
      "Shopify processed the return; the original refund is still pending. Do not request another refund.",
    payment_required:
      "The original exchange was processed and still requires payment. Use its existing Shopify payment page if available; no invoice was resent. Replacement fulfillment remains on hold until payment is verified.",
    payment_pending:
      "Shopify has not confirmed a completed payment for this exchange. Do not pay again while it is being verified. Replacement fulfillment remains on hold.",
    paid: "Shopify confirms the exchange order is paid. This does not mean replacements shipped.",
    no_payment_difference:
      "Shopify processed the original exchange with no payment difference. This does not mean the replacement has shipped.",
  }
  return operations.finishReturn(
    operation.id,
    {
      status: "return_processed",
      returnId,
      orderId: quote.input.orderId,
      orderName: quote.orderName,
      returnStatus: returned.status,
      paymentStatus,
      settlement: quote.settlement,
      ...(paymentUrl ? { paymentUrl } : {}),
      message: messages[paymentStatus],
    },
    operation.revision
  )
}

export const shopifyReturnStatusTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_CHECK_RETURN",
    name: "Check return",
    description:
      "Recover the original return, refund or exchange and check its actual payment status. After verified payment, release only the original exchange payment holds recorded before payment, when fulfillment permissions are granted. Uses this shopper's saved operation, never arbitrary return or fulfillment IDs. Does not repeat refunds, invoices or returns, remove other holds or mark items shipped. Pending or unverified results must not be described as completed.",
    inputSchema: z.toJSONSchema(inputSchema, { target: "draft-07" }),
  },
]

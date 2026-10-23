import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import {
  draftOrderTotals,
  draftOrderSummary,
  summaryFromQuote,
  type DraftOrderTotals,
} from "./shopify-order-create"
import type {
  ShopifyOrderOperation,
  ShopifyOrderStore,
} from "./shopify-order-store"

const inputSchema = z.object({ operationId: z.uuid().optional() }).strict()
const orderFields = `id name email customer { id }
 displayFinancialStatus fullyPaid cancelledAt
 currentTotalPriceSet { presentmentMoney { amount currencyCode } }`
const draftFields = `id tags email customer { id } status invoiceUrl
 ${draftOrderTotals}
 order { ${orderFields} }`

export const CHECK_DRAFT_ORDER = `#graphql
 query DatoolCheckDraftOrder($id: ID!) {
   draftOrder(id: $id) { ${draftFields} }
 }
`
export const FIND_DRAFT_ORDER = `#graphql
 query DatoolFindDraftOrder($query: String!) {
   draftOrders(first: 2, query: $query) {
     nodes { ${draftFields} }
     pageInfo { hasNextPage }
   }
 }
`
export const CHECK_CREATED_ORDER = `#graphql
 query DatoolCheckCreatedOrder($id: ID!) {
   order(id: $id) { ${orderFields} }
 }
`

type Order = {
  id: string
  name: string
  email: string | null
  customer: { id: string } | null
  displayFinancialStatus: string | null
  fullyPaid: boolean
  cancelledAt: string | null
  currentTotalPriceSet: {
    presentmentMoney: { amount: string; currencyCode: string }
  }
}
type Draft = DraftOrderTotals & {
  id: string
  tags: string[]
  email: string | null
  customer: { id: string } | null
  status: string
  invoiceUrl: string | null
  order: Order | null
}

function matchesBuyer(
  record: Pick<Draft, "email" | "customer">,
  operation: ShopifyOrderOperation
) {
  return operation.quote.customerId
    ? record.customer?.id ===
        `gid://shopify/Customer/${operation.quote.customerId}`
    : record.email?.trim().toLowerCase() ===
        operation.quote.input.email.toLowerCase()
}

/** Recover only the persisted intent owned by this verified shopper. No creation or payment writes. */
export async function checkShopifyCheckout(
  input: unknown,
  operations: ShopifyOrderStore,
  graphql: ShopifyGraphqlClient
) {
  const { operationId } = inputSchema.parse(input)
  const operation = await operations.read(operationId)
  if (!operation)
    return {
      status: "not_found",
      message:
        "There is no checkout to check for this store session and conversation.",
    }
  if (operation.status === "failed")
    return {
      status: "not_created",
      operationId: operation.id,
      message:
        "Shopify rejected this attempt before an order was created. Review the details before creating a new order.",
    }
  const processing = {
    status: "processing",
    operationId: operation.id,
    message:
      "The previous order's outcome is still unresolved. Check checkout again shortly; do not create another order or pay twice.",
  }
  // A freshly admitted mutation can still be running. A missing search result is never proof of failure.
  if (
    ["pending", "draft"].includes(operation.status) &&
    operation.updatedAt.getTime() > Date.now() - 120_000
  )
    return processing
  const review = () =>
    operations.finish(
      operation.id,
      {
        status: "needs_review",
        message:
          "The existing checkout needs review by the store team before continuing. Do not create another order or pay again.",
      },
      operation.revision
    )
  const tag = `datool-operation-${operation.id}`
  let order: Order | null = null
  let draft: Draft | null = null
  if (operation.orderId) {
    const data = await shopifyData<{ order: Order | null }>(
      graphql,
      CHECK_CREATED_ORDER,
      { id: operation.orderId }
    )
    order = data.order
    if (
      order &&
      (order.id !== operation.orderId || !matchesBuyer(order, operation))
    )
      return review()
  } else if (operation.draftOrderId) {
    const data = await shopifyData<{ draftOrder: Draft | null }>(
      graphql,
      CHECK_DRAFT_ORDER,
      { id: operation.draftOrderId }
    )
    draft = data.draftOrder
    if (draft && draft.id !== operation.draftOrderId) return review()
  } else {
    const data = await shopifyData<{
      draftOrders: { nodes: Draft[]; pageInfo: { hasNextPage: boolean } }
    }>(graphql, FIND_DRAFT_ORDER, { query: `tag:"${tag}"` })
    // Search can be eventually consistent or return partial matches. Never trust the filter alone.
    const matches = data.draftOrders.nodes.filter((node) =>
      node.tags.includes(tag)
    )
    if (matches.length > 1 || data.draftOrders.pageInfo.hasNextPage)
      return review()
    draft = matches[0] ?? null
  }
  if (draft) {
    if (!draft.tags.includes(tag) || !matchesBuyer(draft, operation))
      return review()
    order = draft.order
    if (order && !matchesBuyer(order, operation)) return review()
  }
  if (order) {
    const paid = order.displayFinancialStatus === "PAID" && order.fullyPaid
    const payment = paid
      ? "Shopify confirms payment is complete."
      : `Payment status: ${(order.displayFinancialStatus ?? "UNKNOWN").toLowerCase().replaceAll("_", " ")}.`
    return operations.finish(
      operation.id,
      {
        status: order.cancelledAt ? "order_cancelled" : "order_created",
        ...(draft ? { draftOrderId: draft.id } : {}),
        orderId: order.id,
        orderName: order.name,
        financialStatus: order.displayFinancialStatus,
        paid,
        total: order.currentTotalPriceSet.presentmentMoney,
        message: `Order ${order.name} ${order.cancelledAt ? "was cancelled" : "is placed"}. ${payment}`,
      },
      operation.revision
    )
  }
  if (!draft) return processing
  if (!["OPEN", "INVOICE_SENT"].includes(draft.status)) return processing
  if (
    operation.quote.paymentMethod !== "online" ||
    JSON.stringify(draftOrderSummary(draft)) !==
      JSON.stringify(summaryFromQuote(operation.quote)) ||
    !draft.invoiceUrl?.startsWith("https://") ||
    !isSafeHttpUrl(draft.invoiceUrl)
  )
    return review()
  return operations.finish(
    operation.id,
    {
      status: "checkout_ready",
      draftOrderId: draft.id,
      checkoutUrl: draft.invoiceUrl,
      paid: false,
      total: operation.quote.total,
      message: `Your existing Shopify checkout is ready. Payment has not been confirmed.\n\n[Continue to Shopify checkout](<${draft.invoiceUrl}>)`,
    },
    operation.revision
  )
}

export const shopifyCheckoutTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_CHECK_CHECKOUT",
    name: "Check checkout",
    description:
      "Check payment or recover the outcome of an order created in this storefront conversation. Use the operationId returned by Create order, or omit it for the latest attempt. Reads the existing Shopify draft or order without creating another one or taking payment. Never infer payment from a checkout link. An unresolved or review-required result must not be retried with Create order.",
    inputSchema: z.toJSONSchema(inputSchema, { target: "draft-7" }),
  },
]

import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyReturnInputSchema,
  type ShopifyReturnQuote,
} from "@/src/lib/build/shopify-return"
import { TracerError } from "@/src/server/tracer/errors"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import type { ShopifyOperationStore } from "./shopify-operation-store"
import { canAccessShopifyOrder } from "./shopify-orders"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"
import {
  prepareShopifyReturn,
  totalShopifyMoney,
  type ShopifyMoney,
} from "./shopify-return-quote"

const money = `presentmentMoney { amount currencyCode }`
const lines = `returnLineItems(first: 100) {
  nodes { id quantity processedQuantity ... on ReturnLineItem { fulfillmentLineItem { id } } }
  pageInfo { hasNextPage }
}
exchangeLineItems(first: 100) {
  nodes { id quantity processedQuantity variantId } pageInfo { hasNextPage }
}`
export const CREATE_RETURN = `#graphql
 mutation DatoolCreateReturn($input: ReturnInput!) {
   returnCreate(returnInput: $input) {
     return { id order { id } ${lines} } userErrors { field message }
   }
 }
`
export const RETURN_FINANCIAL_OUTCOME = `#graphql
 query DatoolReturnFinancialOutcome($id: ID!, $items: [SuggestedOutcomeReturnLineItemInput!]!, $replacements: [SuggestedOutcomeExchangeLineItemInput!]!) {
   return(id: $id) {
     id order { id name email phone customer { id } shippingAddress { phone } }
     suggestedFinancialOutcome(returnLineItems: $items, exchangeLineItems: $replacements, refundMethodAllocation: ORIGINAL_PAYMENT_METHODS) {
       financialTransfer {
         __typename
         ... on RefundReturnOutcome {
           amount { ${money} }
           suggestedTransactions {
             kind amountSet { ${money} } maximumRefundableSet { ${money} }
             parentTransaction { id kind }
           }
         }
         ... on InvoiceReturnOutcome { amount { ${money} } }
       }
     }
   }
 }
`
export const PROCESS_RETURN = `#graphql
 mutation DatoolProcessReturn($input: ReturnProcessInput!) {
   returnProcess(input: $input) {
     return {
       id ${lines}
       order { id totalOutstandingSet { ${money} } }
       transactions(first: 100) {
         nodes { id kind status amountSet { ${money} } }
         pageInfo { hasNextPage }
       }
     }
     userErrors { field message }
   }
 }
`
export const INVOICE_EXCHANGE = `#graphql
 mutation DatoolInvoiceExchange($id: ID!) {
   orderInvoiceSend(id: $id) { order { id } userErrors { field message } }
 }
`

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } }
type Line = { id: string; quantity: number; processedQuantity: number }
type ReturnLines = {
  id: string
  returnLineItems: Page<Line & { fulfillmentLineItem?: { id: string } }>
  exchangeLineItems: Page<Line & { variantId: string | null }>
}
type Transaction = {
  id: string
  kind: string
  status: string
  amountSet: { presentmentMoney: ShopifyMoney }
}
type FinancialTransfer = {
  __typename: string
  amount: { presentmentMoney: ShopifyMoney }
  suggestedTransactions?: Array<{
    kind: string
    amountSet: { presentmentMoney: ShopifyMoney }
    maximumRefundableSet: { presentmentMoney: ShopifyMoney } | null
    parentTransaction: { id: string; kind: string } | null
  }>
}

function sameMoney(a: ShopifyMoney, b: ShopifyMoney) {
  return (
    totalShopifyMoney(
      [{ value: a }, { value: b, subtract: true }],
      a.currencyCode
    ).amount === "0"
  )
}

function matchesLines(
  record: ReturnLines,
  quote: ShopifyReturnQuote,
  processed: boolean
) {
  return (
    !record.returnLineItems.pageInfo.hasNextPage &&
    !record.exchangeLineItems.pageInfo.hasNextPage &&
    record.returnLineItems.nodes.length === quote.input.items.length &&
    record.exchangeLineItems.nodes.length === quote.input.replacements.length &&
    quote.input.items.every((item) =>
      record.returnLineItems.nodes.some(
        (line) =>
          line.fulfillmentLineItem?.id === item.fulfillmentLineItemId &&
          line.quantity === item.quantity &&
          line.processedQuantity === (processed ? item.quantity : 0)
      )
    ) &&
    quote.input.replacements.every((item) =>
      record.exchangeLineItems.nodes.some(
        (line) =>
          line.variantId === `gid://shopify/ProductVariant/${item.variantId}` &&
          line.quantity === item.quantity &&
          line.processedQuantity === (processed ? item.quantity : 0)
      )
    )
  )
}

/** Uses only a server-persisted approved quote and Shopify's original payment suggestions. */
export async function processShopifyReturn(
  quote: ShopifyReturnQuote,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operations: ShopifyOperationStore,
  beforeWrite: () => Promise<void>
) {
  if (quote.customerId !== shopper.customerId)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Your customer account changed. Review the return again."
    )
  const refreshed = await prepareShopifyReturn(
    quote.input,
    shopper,
    settings,
    graphql,
    quote.operationId
  )
  if (
    quote.expiresAt <= Date.now() ||
    quote.fingerprint !== refreshed.fingerprint
  )
    return { status: "quote_changed" as const, quote: refreshed }
  await operations.beginReturn(quote, settings)
  let providerCreated = false
  try {
    const created = await shopifyMutation<{
      return: (ReturnLines & { order: { id: string } }) | null
    }>(
      graphql,
      CREATE_RETURN,
      {
        input: {
          orderId: quote.input.orderId,
          returnLineItems: quote.input.items.map((item) => ({
            ...item,
            returnReasonNote: `${quote.input.reason}\nDatool:${quote.operationId}`,
          })),
          exchangeLineItems: quote.input.replacements.map((item) => ({
            variantId: `gid://shopify/ProductVariant/${item.variantId}`,
            quantity: item.quantity,
          })),
        },
      },
      "returnCreate",
      beforeWrite
    )
    providerCreated = true
    const returned = created.return
    if (!returned?.id) throw new ShopifyWriteUncertainError()
    await operations.recordReturn(quote.operationId, returned.id)
    const review = (message: string) =>
      operations.finishReturn(quote.operationId, {
        status: "needs_review" as const,
        returnId: returned.id,
        orderId: quote.input.orderId,
        message,
      })
    if (
      returned.order.id !== quote.input.orderId ||
      !matchesLines(returned, quote, false)
    )
      return await review(
        "Shopify created a different return than expected. The store team must review it before any refund or exchange processing."
      )
    const items = returned.returnLineItems.nodes.map(({ id, quantity }) => ({
      id,
      quantity,
    }))
    const replacements = returned.exchangeLineItems.nodes.map(
      ({ id, quantity }) => ({ id, quantity })
    )
    const outcome = await shopifyData<{
      return: {
        id: string
        order: {
          id: string
          name: string
          email: string | null
          phone: string | null
          customer: { id: string } | null
          shippingAddress: { phone: string | null } | null
        }
        suggestedFinancialOutcome: {
          financialTransfer: FinancialTransfer | null
        } | null
      } | null
    }>(graphql, RETURN_FINANCIAL_OUTCOME, {
      id: returned.id,
      items,
      replacements,
    })
    const current = outcome.return
    if (
      !current ||
      current.id !== returned.id ||
      current.order.id !== quote.input.orderId ||
      !canAccessShopifyOrder(current.order, quote.input, shopper)
    )
      return await review(
        "Order access changed. The store team must review this return before processing it."
      )
    const transfer = current.suggestedFinancialOutcome?.financialTransfer
    const expectedDirection = quote.settlement.direction
    const direction =
      transfer?.__typename === "InvoiceReturnOutcome"
        ? "collect"
        : transfer?.__typename === "RefundReturnOutcome"
          ? "refund"
          : null
    if (
      !current.suggestedFinancialOutcome ||
      (expectedDirection === "even"
        ? transfer &&
          (!direction ||
            !sameMoney(transfer.amount.presentmentMoney, quote.settlement))
        : direction !== expectedDirection ||
          !transfer ||
          !sameMoney(transfer.amount.presentmentMoney, quote.settlement))
    )
      return await review(
        "Shopify changed the return balance. No refund or exchange was processed. The store team must review the updated amount."
      )
    let financialTransfer: Record<string, unknown> | undefined
    if (expectedDirection === "refund") {
      const transactions = transfer?.suggestedTransactions ?? []
      const invalid =
        transactions.length === 0 ||
        transactions.some(
          (tx) =>
            tx.kind !== "REFUND" ||
            !tx.parentTransaction ||
            !["CAPTURE", "SALE"].includes(tx.parentTransaction.kind) ||
            (tx.maximumRefundableSet &&
              totalShopifyMoney(
                [
                  { value: tx.maximumRefundableSet.presentmentMoney },
                  { value: tx.amountSet.presentmentMoney, subtract: true },
                ],
                quote.settlement.currencyCode
              ).amount.startsWith("-"))
        )
      if (
        invalid ||
        !sameMoney(
          totalShopifyMoney(
            transactions.map((tx) => ({
              value: tx.amountSet.presentmentMoney,
            })),
            quote.settlement.currencyCode
          ),
          quote.settlement
        )
      )
        return await review(
          "Shopify could not refund the approved amount to the original payment methods. The store team must review the refund."
        )
      financialTransfer = {
        issueRefund: {
          // Shopify's suggested maximum is nullable. The approved exact amount
          // and this provider-side restriction still prohibit over-refunding.
          allowOverRefunding: false,
          orderTransactions: transactions.map((tx) => ({
            parentId: tx.parentTransaction!.id,
            transactionAmount: tx.amountSet.presentmentMoney,
          })),
        },
      }
    }
    await operations.claimReturnProcessing(quote.operationId)
    const processed = await shopifyMutation<{
      return:
        | (ReturnLines & {
            order: {
              id: string
              totalOutstandingSet: { presentmentMoney: ShopifyMoney }
            }
            transactions: Page<Transaction>
          })
        | null
    }>(
      graphql,
      PROCESS_RETURN,
      {
        input: {
          returnId: returned.id,
          returnLineItems: items,
          exchangeLineItems: replacements,
          ...(financialTransfer ? { financialTransfer } : {}),
          note: `Datool:${quote.operationId}`,
          notifyCustomer: true,
          // Do not claim physical receipt, restock items, or dispose of them from chat.
        },
      },
      "returnProcess",
      beforeWrite
    )
    const actual = processed.return
    if (
      !actual ||
      actual.id !== returned.id ||
      !matchesLines(actual, quote, true)
    )
      throw new ShopifyWriteUncertainError()
    let paymentStatus:
      | "refunded"
      | "refund_pending"
      | "payment_required"
      | "no_payment_difference" = "no_payment_difference"
    if (expectedDirection === "refund") {
      const refunds = actual.transactions.nodes.filter(
        (tx) => tx.kind === "REFUND"
      )
      if (
        actual.transactions.pageInfo.hasNextPage ||
        !refunds.length ||
        refunds.some(
          (tx) =>
            !["SUCCESS", "PENDING", "AWAITING_RESPONSE"].includes(tx.status)
        ) ||
        !sameMoney(
          totalShopifyMoney(
            refunds.map((tx) => ({ value: tx.amountSet.presentmentMoney })),
            quote.settlement.currencyCode
          ),
          quote.settlement
        )
      )
        return await review(
          "The return was processed, but Shopify has not confirmed the expected refund. The store team must inspect its transactions before another refund attempt."
        )
      paymentStatus = refunds.every((tx) => tx.status === "SUCCESS")
        ? "refunded"
        : "refund_pending"
    }
    if (expectedDirection === "collect") {
      // An order invoice collects the whole outstanding balance, including any
      // earlier unpaid amount. Never invoice more than the approved exchange.
      if (
        actual.order.id !== quote.input.orderId ||
        !sameMoney(
          actual.order.totalOutstandingSet.presentmentMoney,
          quote.settlement
        )
      )
        return await review(
          "The exchange was processed, but the order's outstanding balance differs from the approved amount. No invoice was sent; the store team must review the balance before collecting payment."
        )
      const invoice = await shopifyMutation<{ order: { id: string } | null }>(
        graphql,
        INVOICE_EXCHANGE,
        { id: quote.input.orderId },
        "orderInvoiceSend",
        beforeWrite
      )
      if (invoice.order?.id !== quote.input.orderId)
        throw new ShopifyWriteUncertainError()
      paymentStatus = "payment_required"
    }
    return await operations.finishReturn(quote.operationId, {
      status: "return_processed" as const,
      returnId: returned.id,
      orderId: quote.input.orderId,
      orderName: quote.orderName,
      paymentStatus,
      settlement: quote.settlement,
      message:
        paymentStatus === "payment_required"
          ? "Shopify processed the exchange and sent a payment invoice to the order's email. Replacement fulfillment remains on hold until payment is verified."
          : paymentStatus === "refund_pending"
            ? "Shopify processed the return. The refund is pending with the original payment provider."
            : paymentStatus === "refunded"
              ? "Shopify confirmed the refund to the original payment method. Your bank may take time to show it."
              : "Shopify processed the exchange with no payment difference. This does not mean the replacement has shipped.",
    })
  } catch (error) {
    try {
      await operations.fail(
        quote.operationId,
        providerCreated || error instanceof ShopifyWriteUncertainError
      )
    } catch {
      throw new ShopifyWriteUncertainError()
    }
    if (providerCreated) throw new ShopifyWriteUncertainError()
    throw error
  }
}

export const shopifyReturnTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_RETURN_OR_EXCHANGE",
    name: "Return or exchange items",
    description:
      "Prepare a return/refund or permitted same-order exchange. First use Find returnable items; select fulfillment line IDs and quantities. Shopify calculates the balance for shopper confirmation or merchant approval. Guests must provide the order number and checkout email or phone. Never promise a completed refund or shipment before Shopify confirms it.",
    inputSchema: z.toJSONSchema(shopifyReturnInputSchema, {
      target: "draft-07",
    }),
  },
]

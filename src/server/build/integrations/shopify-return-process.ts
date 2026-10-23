import { z } from "zod"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyReturnActionInputSchema,
  type ShopifyReturnQuote,
} from "@/src/lib/build/shopify-return"
import { prepareShopifyReturnContinuation } from "./shopify-return-resume"
import { readReturnFinancialOutcome } from "./shopify-return-financial"
import { CHECK_CREATED_RETURN } from "./shopify-return-status"
import { reconcileShopifyExchangeFulfillment } from "./shopify-exchange-fulfillment"
import { TracerError } from "@/src/server/tracer/errors"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import type { ShopifyOperationStore } from "./shopify-operation-store"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"
import {
  prepareShopifyReturn,
  totalShopifyMoney,
  type ShopifyMoney,
} from "./shopify-return-quote"
import {
  sameShopifyMoney,
  matchesReturnLines,
  type ReturnLines,
  type ReturnPage,
  type ReturnTransaction,
  shopifyRefundStatus,
} from "./shopify-return-record"

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

/** Uses only a server-persisted approved quote and Shopify's original payment suggestions. */
export async function processShopifyReturn(
  quote: ShopifyReturnQuote,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operations: ShopifyOperationStore,
  beforeWrite: () => Promise<void>,
  manageExchangeHolds = false
) {
  if (quote.customerId !== shopper.customerId)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Your customer account changed. Review the return again."
    )
  const refreshed = quote.resume
    ? await prepareShopifyReturnContinuation(
        { operationId: quote.operationId },
        shopper,
        settings,
        graphql,
        operations
      )
    : await prepareShopifyReturn(
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
  if (!quote.resume) await operations.beginReturn(quote, settings)
  let providerCreated = Boolean(quote.resume)
  let processing = false
  try {
    const created = quote.resume
      ? await shopifyData<{
          return: (ReturnLines & { order: { id: string } }) | null
        }>(graphql, CHECK_CREATED_RETURN, { id: quote.resume.returnId })
      : await shopifyMutation<{
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
    if (!quote.resume)
      await operations.recordReturn(quote.operationId, returned.id)
    const review = (message: string) =>
      operations.finishReturn(
        quote.operationId,
        {
          status: "needs_review" as const,
          returnId: quote.resume?.returnId ?? returned.id,
          orderId: quote.input.orderId,
          message,
        },
        quote.resume && !processing ? quote.resume.revision : undefined
      )
    if (
      (quote.resume && returned.id !== quote.resume.returnId) ||
      returned.order.id !== quote.input.orderId ||
      !matchesReturnLines(returned, quote, false)
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
    let outcome: Awaited<ReturnType<typeof readReturnFinancialOutcome>>
    try {
      outcome = await readReturnFinancialOutcome(
        returned,
        quote,
        shopper,
        graphql
      )
    } catch (error) {
      if (error instanceof TracerError && error.code === "VALIDATION_ERROR")
        return await review(error.message)
      throw error
    }
    const transfer = outcome.financialTransfer
    const expectedDirection = quote.settlement.direction
    const direction =
      transfer?.__typename === "InvoiceReturnOutcome"
        ? "collect"
        : transfer?.__typename === "RefundReturnOutcome"
          ? "refund"
          : null
    if (
      expectedDirection === "even"
        ? transfer &&
          (!direction ||
            !sameShopifyMoney(
              transfer.amount.presentmentMoney,
              quote.settlement
            ))
        : direction !== expectedDirection ||
          !transfer ||
          !sameShopifyMoney(transfer.amount.presentmentMoney, quote.settlement)
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
        !sameShopifyMoney(
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
    await operations.claimReturnProcessing(quote)
    processing = true
    const processed = await shopifyMutation<{
      return:
        | (ReturnLines & {
            order: {
              id: string
              totalOutstandingSet: { presentmentMoney: ShopifyMoney }
            }
            transactions: ReturnPage<ReturnTransaction>
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
      !matchesReturnLines(actual, quote, true)
    )
      throw new ShopifyWriteUncertainError()
    let paymentStatus:
      | "refunded"
      | "refund_pending"
      | "payment_required"
      | "no_payment_difference" = "no_payment_difference"
    if (expectedDirection === "refund") {
      const refundStatus = shopifyRefundStatus(
        actual.transactions,
        quote.settlement
      )
      if (!refundStatus)
        return await review(
          "The return was processed, but Shopify has not confirmed the expected refund. The store team must inspect its transactions before another refund attempt."
        )
      paymentStatus = refundStatus
    }

    if (expectedDirection === "collect") {
      // An order invoice collects the whole outstanding balance, including any
      // earlier unpaid amount. Never invoice more than the approved exchange.
      if (
        actual.order.id !== quote.input.orderId ||
        !sameShopifyMoney(
          actual.order.totalOutstandingSet.presentmentMoney,
          quote.settlement
        )
      )
        return await review(
          "The exchange was processed, but the order's outstanding balance differs from the approved amount. No invoice was sent; the store team must review the balance before collecting payment."
        )
      if (manageExchangeHolds)
        await reconcileShopifyExchangeFulfillment(
          quote.operationId,
          shopper,
          operations,
          graphql
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
      "Prepare a return/refund or permitted same-order exchange. First use Find returnable items; select fulfillment line IDs and quantities. Shopify calculates the balance for shopper confirmation or merchant approval. Guests must provide the order number and checkout email or phone. To continue an existing unprocessed return, pass only its Datool operationId; the original items and current balance require fresh approval. Never promise a completed refund or shipment before Shopify confirms it.",
    inputSchema: z.toJSONSchema(shopifyReturnActionInputSchema, {
      target: "draft-07",
    }),
  },
]

import type { ShopifyReturnQuote } from "@/src/lib/build/shopify-return"
import { totalShopifyMoney, type ShopifyMoney } from "./shopify-return-quote"

export type ReturnPage<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } }
type Line = { id: string; quantity: number; processedQuantity: number }
export type ReturnLines = {
  id: string
  returnLineItems: ReturnPage<Line & { fulfillmentLineItem?: { id: string } }>
  exchangeLineItems: ReturnPage<Line & { variantId: string | null }>
}
export type ReturnTransaction = {
  id: string
  kind: string
  status: string
  amountSet: { presentmentMoney: ShopifyMoney }
}
export function sameShopifyMoney(a: ShopifyMoney, b: ShopifyMoney) {
  return (
    totalShopifyMoney(
      [{ value: a }, { value: b, subtract: true }],
      a.currencyCode
    ).amount === "0"
  )
}

export function matchesReturnLines(
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
/** Only Shopify-confirmed transactions for the exact approved refund count as settlement. */
export function shopifyRefundStatus(
  transactions: ReturnPage<ReturnTransaction>,
  expected: ShopifyMoney
): "refunded" | "refund_pending" | null {
  const refunds = transactions.nodes.filter((tx) => tx.kind === "REFUND")
  if (
    transactions.pageInfo.hasNextPage ||
    !refunds.length ||
    new Set(refunds.map((tx) => tx.id)).size !== refunds.length ||
    refunds.some(
      (tx) => !["SUCCESS", "PENDING", "AWAITING_RESPONSE"].includes(tx.status)
    ) ||
    !sameShopifyMoney(
      totalShopifyMoney(
        refunds.map((tx) => ({ value: tx.amountSet.presentmentMoney })),
        expected.currencyCode
      ),
      expected
    )
  )
    return null
  return refunds.every((tx) => tx.status === "SUCCESS")
    ? "refunded"
    : "refund_pending"
}

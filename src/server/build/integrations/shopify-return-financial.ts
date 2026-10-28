import { TracerError } from "@/src/server/tracer/errors"
import type { ShopifyReturnQuote } from "@/src/lib/build/shopify-return"
import type { ShopifyShopper } from "./shopify-identity"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import { canAccessShopifyOrder } from "./shopify-orders"
import type { ReturnLines } from "./shopify-return-record"
import type { ShopifyMoney } from "./shopify-return-quote"

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

const money = `presentmentMoney { amount currencyCode }`
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

export async function readReturnFinancialOutcome(
  returned: ReturnLines,
  quote: ShopifyReturnQuote,
  shopper: ShopifyShopper,
  graphql: ShopifyGraphqlClient
) {
  const data = await shopifyData<{
    return: {
      id: string
      order: Parameters<typeof canAccessShopifyOrder>[0] & { id: string }
      suggestedFinancialOutcome: {
        financialTransfer: FinancialTransfer | null
      } | null
    } | null
  }>(graphql, RETURN_FINANCIAL_OUTCOME, {
    id: returned.id,
    items: returned.returnLineItems.nodes.map(({ id, quantity }) => ({
      id,
      quantity,
    })),
    replacements: returned.exchangeLineItems.nodes.map(({ id, quantity }) => ({
      id,
      quantity,
    })),
  })
  const current = data.return
  if (
    !current ||
    current.id !== returned.id ||
    current.order.id !== quote.input.orderId ||
    !canAccessShopifyOrder(current.order, quote.input, shopper)
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Order access changed. The store team must review this return before processing it."
    )
  if (!current.suggestedFinancialOutcome)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify could not calculate this return's current balance. Ask the store team to review it."
    )
  return current.suggestedFinancialOutcome
}

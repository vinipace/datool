import type { ShopifyShopper } from "./shopify-identity"
import type { ShopifyOperationStore } from "./shopify-operation-store"
import type { ShopifyGraphqlClient } from "./shopify-catalog"
import { checkShopifyReturn } from "./shopify-return-status"
import { reconcileShopifyExchangeFulfillment } from "./shopify-exchange-fulfillment"

/** Both shopper checks and the worker reconcile the same approved return. */
export async function reconcileShopifyReturn(
  input: unknown,
  shopper: ShopifyShopper,
  operations: ShopifyOperationStore,
  graphql: ShopifyGraphqlClient,
  manageExchangeHolds: boolean,
  beforeWrite: () => Promise<void>
) {
  const result = await checkShopifyReturn(input, shopper, operations, graphql)
  if (
    !("paymentStatus" in result) ||
    !["payment_required", "paid"].includes(result.paymentStatus)
  )
    return result
  const fulfillment = manageExchangeHolds
    ? await reconcileShopifyExchangeFulfillment(
        result.operationId,
        shopper,
        operations,
        graphql,
        beforeWrite
      )
    : {
        fulfillmentStatus: "permission_required",
        message:
          "The store team must grant fulfillment access before Datool can release the exchange payment holds. Return and payment status remain available.",
      }
  return {
    ...result,
    fulfillmentStatus: fulfillment.fulfillmentStatus,
    message: `${result.message} ${fulfillment.message}`,
  }
}

import { createHash } from "node:crypto"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyReturnResumeInputSchema,
  shopifyReturnQuoteSchema,
} from "@/src/lib/build/shopify-return"
import { TracerError } from "@/src/server/tracer/errors"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import type { ShopifyOperationStore } from "./shopify-operation-store"
import { canAccessShopifyOrder } from "./shopify-orders"
import {
  checkShopifyReturn,
  CHECK_CREATED_RETURN,
  type ReturnRecord,
} from "./shopify-return-status"
import { matchesReturnLines } from "./shopify-return-record"
import { readReturnFinancialOutcome } from "./shopify-return-financial"
import {
  getShopifyReplacementItems,
  totalShopifyMoney,
} from "./shopify-return-quote"

function invalid(message: string): never {
  throw new TracerError("VALIDATION_ERROR", message)
}

/** Requote an existing approved return only when no financial processing attempt was admitted. */
export async function prepareShopifyReturnContinuation(
  input: unknown,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operations: ShopifyOperationStore
) {
  const { operationId } = shopifyReturnResumeInputSchema.parse(input)
  let operation = await operations.readReturn(operationId)
  if (!operation)
    invalid(
      "There is no return to continue for this store session and conversation."
    )
  if (!operation.returnId) {
    await checkShopifyReturn({ operationId }, shopper, operations, graphql)
    operation = await operations.readReturn(operationId)
  }
  if (!operation?.returnId)
    invalid(
      "The original return has not been uniquely recovered. Use Check return before continuing."
    )
  if (operation.processingStarted)
    invalid(
      "Processing already started or its outcome is unknown. Use Check return; the original refund or exchange cannot be replayed."
    )
  if (
    !["return_created", "uncertain", "needs_review"].includes(
      operation.status
    ) ||
    (operation.status === "return_created" &&
      operation.updatedAt.getTime() > Date.now() - 120_000)
  )
    invalid(
      "The original return is still processing or cannot be continued. Use Check return for its current status."
    )
  const original = operation.quote
  if (
    original.input.replacements.length &&
    (!settings.allowExchanges || !operation.settings.allowExchanges)
  )
    invalid(
      "This store's action no longer allows this exchange. Ask the store team to review the original return."
    )
  const { return: returned } = await shopifyData<{
    return: ReturnRecord | null
  }>(graphql, CHECK_CREATED_RETURN, { id: operation.returnId })
  if (
    !returned ||
    returned.id !== operation.returnId ||
    returned.order.id !== original.input.orderId ||
    !canAccessShopifyOrder(returned.order, original.input, shopper)
  )
    invalid(
      "Order access changed. The store team must review this return before processing it."
    )
  if (
    returned.status !== "OPEN" ||
    returned.order.cancelledAt ||
    !matchesReturnLines(returned, original, false) ||
    returned.transactions.nodes.length ||
    returned.transactions.pageInfo.hasNextPage
  )
    invalid(
      "The return is no longer wholly unprocessed. Use Check return before any further refund or exchange."
    )
  // Its items were accepted into this existing return. Do not consume returnable
  // quantities again or reject an accepted return merely because time passed.
  const replacements = await getShopifyReplacementItems(
    original.input.replacements,
    graphql
  )
  const { financialTransfer } = await readReturnFinancialOutcome(
    returned,
    original,
    shopper,
    graphql
  )
  if (
    financialTransfer &&
    !["RefundReturnOutcome", "InvoiceReturnOutcome"].includes(
      financialTransfer.__typename
    )
  )
    invalid(
      "Shopify returned an unsupported settlement. Ask the store team to review this return."
    )
  const amount = totalShopifyMoney(
    financialTransfer
      ? [{ value: financialTransfer.amount.presentmentMoney }]
      : [],
    original.settlement.currencyCode
  )
  const confirmed = {
    operationId,
    customerId: shopper.customerId,
    orderName: returned.order.name,
    input: original.input,
    items: original.items,
    replacements,
    settlement: {
      ...amount,
      direction:
        amount.amount === "0"
          ? "even"
          : financialTransfer?.__typename === "InvoiceReturnOutcome"
            ? "collect"
            : "refund",
    },
    resume: {
      returnId: operation.returnId,
      revision: operation.revision,
      requireHumanApproval:
        settings.requireHumanApproval ||
        operation.settings.requireHumanApproval ||
        settings.returnWindowDays !== operation.settings.returnWindowDays,
    },
  }
  return shopifyReturnQuoteSchema.parse({
    ...confirmed,
    expiresAt: Date.now() + 15 * 60_000,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ ...confirmed, settings }))
      .digest("hex"),
  })
}

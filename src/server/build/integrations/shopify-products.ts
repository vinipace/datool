import { randomUUID } from "node:crypto"
import type { ActionDefinition, ActionRecord } from "@/src/lib/build/contracts"
import {
  shopifyProductsSchema,
  shopifyProductSearchSchema,
  shopifyProductSelectionSchema,
  type ShopifyProducts,
} from "@/src/lib/build/shopify-products"
import type { Conversation, ConversationTurn } from "../conversation-schema"
import type { ConversationService } from "../conversations"
import type { RuntimeContinuation } from "../runtime"

/** Product cards use the same saved cart action, approval gate and one-shot ledger as agent calls. */
export async function prepareShopifyProductCards(
  output: unknown,
  action: Extract<ActionDefinition, { type: "integration" }>,
  actions: Map<string, ActionRecord>,
  service: ConversationService,
  conversation: Conversation,
  turn: ConversationTurn,
  toolCallId: string,
  input: Record<string, unknown>
): Promise<ShopifyProducts> {
  const catalog = shopifyProductsSchema.parse(output)
  const cartActions = [...actions.values()].filter(
    (candidate) =>
      candidate.definition.type === "integration" &&
      candidate.definition.toolSlug === "SHOPIFY_UPDATE_CART" &&
      candidate.definition.connectionId === action.connectionId &&
      !candidate.definition.procedureOnly &&
      candidate.definition.enabled &&
      candidate.definition.channels.includes(conversation.channel)
  )
  // Choosing arbitrarily between differently configured cart actions could bypass merchant policy.
  const cartAction =
    conversation.channel === "web" && cartActions.length === 1
      ? cartActions[0]
      : null
  for (const product of catalog.products) {
    if (product.variantsNextCursor && conversation.channel === "web") {
      const pageInput = shopifyProductSearchSchema.parse(input)
      delete pageInput.after
      const continuation: RuntimeContinuation = {
        type: "client_action",
        actionId: action.id,
        continuationId: randomUUID(),
        input: {
          ...pageInput,
          productId: product.id,
          variantAfter: product.variantsNextCursor,
        },
        shopifyVariantPage: { expiresAt: Date.now() + 60 * 60_000 },
      }
      const pageCallId = `variants:${randomUUID()}`
      await service.recordToolCallStart({
        conversationId: conversation.id,
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        toolCallId: pageCallId,
        actionId: action.id,
        args: { productId: product.id },
      })
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        toolCallId: pageCallId,
        status: "awaiting_client",
        output: continuation,
        continuation,
      })
      product.variantInteraction = {
        actionId: action.id,
        continuationId: continuation.continuationId!,
      }
    }
    if (!cartAction) continue
    const variantIds = product.variants
      .filter((variant) => variant.availableForSale && variant.cartVariantId)
      .map((variant) => variant.cartVariantId!)
    if (!variantIds.length) continue
    const continuation: RuntimeContinuation = {
      type: "client_action",
      actionId: cartAction.id,
      continuationId: randomUUID(),
      input: {},
      shopifyProductSelection: {
        variantIds,
        expiresAt: Date.now() + 60 * 60_000,
      },
    }
    const selectionCallId = `${toolCallId}:product:${product.id.split("/").at(-1)}`
    await service.recordToolCallStart({
      conversationId: conversation.id,
      turnId: turn.id,
      ownerFence: turn.ownerFence,
      toolCallId: selectionCallId,
      actionId: cartAction.id,
      args: { productId: product.id },
    })
    await service.recordToolCallFinish({
      conversationId: conversation.id,
      turnId: turn.id,
      ownerFence: turn.ownerFence,
      toolCallId: selectionCallId,
      status: "awaiting_client",
      output: continuation,
      continuation,
    })
    product.cartInteraction = {
      actionId: cartAction.id,
      continuationId: continuation.continuationId!,
    }
  }
  return catalog
}

export function selectedShopifyCartInput(
  input: unknown,
  selection: NonNullable<RuntimeContinuation["shopifyProductSelection"]>
) {
  const chosen = shopifyProductSelectionSchema.parse(input)
  if (
    selection.expiresAt <= Date.now() ||
    !selection.variantIds.includes(chosen.variantId)
  )
    throw new Error(
      "This product selection is no longer available. Search for the product again."
    )
  return { operation: "add", items: [chosen] }
}

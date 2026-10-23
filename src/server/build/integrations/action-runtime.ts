import { z } from "zod"
import type { ActionDefinition, ActionRecord } from "@/src/lib/build/contracts"
import {
  shopifyOrderQuoteSchema,
  shopifyOrderSummary,
  type ShopifyOrderQuote,
} from "@/src/lib/build/shopify-order"
import {
  shopifyReturnQuoteSchema,
  shopifyReturnSummary,
  type ShopifyReturnQuote,
} from "@/src/lib/build/shopify-return"
import { shopifyProductSearchSchema } from "@/src/lib/build/shopify-products"
import {
  isShopifyCartTool,
  shopifyCartCommandSchema,
  type ShopifyCartCommand,
} from "@/src/lib/build/shopify-cart"
import { shopifyActionNeedsConfirmation } from "@/src/lib/build/shopify"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import type { Conversation, ConversationTurn } from "../conversation-schema"
import type { ConversationService } from "../conversations"
import type { RuntimeContinuation } from "../runtime"
import {
  prepareShopifyProductCards,
  selectedShopifyCartInput,
} from "./shopify-products"
import { shopifyApprovalNeedsVerification } from "./shopify-identity"
import { executeAppAction } from "./service"
import { shopifyCartToolInputSchema } from "./shopify-cart"
import { shopifyReturnToolInputSchema } from "./shopify-return-process"

export type IntegrationExecutionOptions = {
  toolCallId: string
  availableActions?: Map<string, ActionRecord>
  requireHumanForActions?: boolean
  allowApproval?: boolean
  shopifyConfirmed?: boolean
  shopifyCartResult?: unknown
  shopifyReturnQuote?: ShopifyReturnQuote
  shopifyOrderQuote?: ShopifyOrderQuote
  shopifyCartApproved?: boolean
  shopifySourceTurnId?: string
  shopifyReverification?: boolean
  signal?: AbortSignal
}

export function integrationInputSchema(action: ActionDefinition) {
  if (action.type === "integration") {
    if (action.toolSlug === "SHOPIFY_SEARCH_PRODUCTS")
      return z.toJSONSchema(shopifyProductSearchSchema, { target: "draft-7" })
    if (action.toolSlug === "SHOPIFY_UPDATE_CART")
      return shopifyCartToolInputSchema
    if (action.toolSlug === "SHOPIFY_RETURN_OR_EXCHANGE")
      return shopifyReturnToolInputSchema
  }
  return action.inputSchema
}

export function integrationInputError(
  action: ActionDefinition,
  error: unknown
) {
  return action.type === "integration" &&
    action.toolSlug.startsWith("SHOPIFY_") &&
    error instanceof TracerError &&
    error.code === "VALIDATION_ERROR"
    ? error.message
    : null
}

/** Integration policy stays here. The runtime owns validation, approval, the ledger and procedures. */
export function integrationExecution(
  context: BuildContext,
  service: ConversationService,
  conversation: Conversation,
  turn: ConversationTurn,
  action: Extract<ActionDefinition, { type: "integration" }>,
  input: Record<string, unknown>,
  pendingBase: Pick<
    RuntimeContinuation,
    "actionId" | "continuationId" | "input" | "procedureCursor"
  >,
  options: IntegrationExecutionOptions
) {
  const continuationId = pendingBase.continuationId
  const orderAction =
    action.type === "integration" && action.toolSlug === "SHOPIFY_CREATE_ORDER"
  const returnAction =
    action.type === "integration" &&
    action.toolSlug === "SHOPIFY_RETURN_OR_EXCHANGE"
  const quotedShopifyAction = orderAction || returnAction
  let returnQuote = options.shopifyReturnQuote
  let orderQuote = options.shopifyOrderQuote

  return {
    async prepare(): Promise<RuntimeContinuation | null> {
      if ((orderAction && !orderQuote) || (returnAction && !returnQuote)) {
        const prepared = await executeAppAction(context, {
          connectionId: action.connectionId,
          toolSlug: action.toolSlug,
          agentId: conversation.agentId,
          conversationId: conversation.id,
          turnId: turn.id,
          toolCallId: options.toolCallId,
          arguments: input,
          shopifyPrepareOrder: orderAction,
          shopifyPrepareReturn: returnAction,
          shopifySettings: action.shopifySettings,
          shopifyCartResult: options.shopifyCartResult,
          signal: options.signal,
        })
        const output = prepared.output as {
          cartCommand?: unknown
          orderQuote?: unknown
          returnQuote?: unknown
        }
        if (output.cartCommand)
          return {
            ...pendingBase,
            type: "client_action",
            eventName: "Read cart for checkout",
            title: action.name,
            message:
              "Read your current cart so Shopify can calculate the order. This does not place an order.",
            shopifyCart: {
              command: shopifyCartCommandSchema.parse(output.cartCommand),
              expiresAt: Date.now() + 60 * 60_000,
            },
          }
        if (orderAction)
          orderQuote = shopifyOrderQuoteSchema.parse(output.orderQuote)
        else returnQuote = shopifyReturnQuoteSchema.parse(output.returnQuote)
      }
      return null
    },
    confirmation(): Partial<RuntimeContinuation> | null {
      const needsApproval =
        (options.requireHumanForActions ||
          returnQuote?.resume?.requireHumanApproval ||
          action.shopifySettings?.requireHumanApproval) &&
        !options.allowApproval &&
        !options.shopifyCartApproved
      const needsConfirmation =
        shopifyActionNeedsConfirmation(action.toolSlug) &&
        !options.shopifyConfirmed &&
        !options.allowApproval
      if (!needsApproval && !needsConfirmation) return null
      return {
        type: needsApproval ? "approval_required" : "client_action",
        ...(orderQuote ? { shopifyOrderQuote: orderQuote } : {}),
        ...(returnQuote ? { shopifyReturnQuote: returnQuote } : {}),
        ...(needsApproval
          ? {
              ...(action.toolSlug.startsWith("SHOPIFY_")
                ? { shopifySourceTurnId: turn.id }
                : {}),
            }
          : {
              eventName: "Confirm changes",
              confirmation: true,
              title: action.name,
            }),
        message: [
          needsApproval
            ? "A teammate must approve this action before it runs."
            : "Review the details and confirm to apply this change.",
          orderQuote
            ? shopifyOrderSummary(orderQuote)
            : returnQuote
              ? shopifyReturnSummary(returnQuote)
              : needsApproval
                ? ""
                : JSON.stringify(pendingBase.input, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n"),
      }
    },
    async execute(): Promise<{
      status: "completed" | "awaiting_client" | "failed"
      output: unknown
      continuation: RuntimeContinuation | null
    }> {
      if (
        action.toolSlug.startsWith("SHOPIFY_") &&
        options.allowApproval &&
        options.shopifySourceTurnId &&
        (await shopifyApprovalNeedsVerification(context, {
          connectionId: action.connectionId,
          conversationId: conversation.id,
          turnId: options.shopifySourceTurnId,
          verificationTurnId: options.shopifyReverification
            ? turn.id
            : undefined,
        }))
      )
        return {
          output: null,
          status: "awaiting_client" as const,
          continuation: {
            ...pendingBase,
            type: "client_action",
            eventName: "Continue approved change",
            title: action.name,
            message:
              "A teammate approved this request. Continue from the store to verify your session and apply the reviewed change. Changed or expired quotes need approval again.",
            shopifyApprovedSourceTurnId: options.shopifySourceTurnId,
            ...(orderQuote ? { shopifyOrderQuote: orderQuote } : {}),
            ...(returnQuote ? { shopifyReturnQuote: returnQuote } : {}),
          },
        }
      const result = await executeAppAction(context, {
        connectionId: action.connectionId,
        toolSlug: action.toolSlug,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        arguments: input,
        shopifyConfirmed: options.shopifyConfirmed || options.allowApproval,
        shopifyCartResult: options.shopifyCartResult,
        shopifyOrderQuote: orderQuote,
        shopifyReturnQuote: returnQuote,
        shopifySettings: action.shopifySettings,
        shopifySourceTurnId: options.allowApproval
          ? options.shopifySourceTurnId
          : undefined,
        signal: options.signal,
      })
      if (
        quotedShopifyAction &&
        (result.output as { status?: string }).status === "quote_changed"
      ) {
        const rawQuote = (result.output as { quote: unknown }).quote
        const changedQuote: Pick<
          RuntimeContinuation,
          "shopifyOrderQuote" | "shopifyReturnQuote"
        > = orderAction
          ? { shopifyOrderQuote: shopifyOrderQuoteSchema.parse(rawQuote) }
          : { shopifyReturnQuote: shopifyReturnQuoteSchema.parse(rawQuote) }
        const summary = changedQuote.shopifyOrderQuote
          ? shopifyOrderSummary(changedQuote.shopifyOrderQuote)
          : shopifyReturnSummary(changedQuote.shopifyReturnQuote!)
        const approval =
          options.requireHumanForActions ||
          changedQuote.shopifyReturnQuote?.resume?.requireHumanApproval ||
          action.shopifySettings?.requireHumanApproval
        return {
          output: null,
          status: "awaiting_client" as const,
          continuation: {
            ...pendingBase,
            type: approval ? "approval_required" : "client_action",
            ...changedQuote,
            title: action.name,
            ...(approval
              ? { shopifySourceTurnId: options.shopifySourceTurnId ?? turn.id }
              : { eventName: "Confirm changes", confirmation: true }),
            message: `The details changed or the quote expired. Review the updated details before continuing.\n\n${summary}`,
          },
        }
      }
      const shopifyProducts =
        action.toolSlug === "SHOPIFY_SEARCH_PRODUCTS" &&
        result.status === "completed"
          ? await prepareShopifyProductCards(
              result.output,
              action,
              options.availableActions ?? new Map(),
              service,
              conversation,
              turn,
              options.toolCallId,
              input
            )
          : undefined
      const output = shopifyProducts ?? result.output
      const cartCommand =
        isShopifyCartTool(action.toolSlug) &&
        result.status === "awaiting_client"
          ? shopifyCartCommandSchema.parse(
              (result.output as { cartCommand?: unknown }).cartCommand
            )
          : null
      const cartContinuation: RuntimeContinuation | null = cartCommand
        ? {
            type: "client_action",
            actionId: action.id,
            continuationId,
            eventName:
              cartCommand.operation === "read" ? "Show cart" : "Update cart",
            title: action.name,
            message:
              cartCommand.operation === "read"
                ? "Open your store's cart in this chat."
                : "Apply this change to your store's cart.",
            ...pendingBase,
            shopifyCart: {
              command: cartCommand,
              expiresAt: Date.now() + 60 * 60_000,
            },
          }
        : null

      return {
        ...result,
        output: cartContinuation ?? output,
        continuation: cartContinuation,
      }
    },
  }
}

/** Resolve only claimed, persisted interaction state; transport metadata cannot approve an action. */
export function integrationInteraction(
  action: ActionDefinition,
  persistedContinuation: Record<string, unknown>,
  interaction: { input: Record<string, unknown> },
  trustedApproval: boolean
) {
  const continuationType = persistedContinuation.type
  let productSelectionInput: Record<string, unknown> | undefined
  if (
    persistedContinuation.shopifyProductSelection ||
    persistedContinuation.shopifyVariantPage
  ) {
    if (persistedContinuation.shopifyVariantPage) {
      const page = persistedContinuation.shopifyVariantPage as NonNullable<
        RuntimeContinuation["shopifyVariantPage"]
      >
      if (
        continuationType !== "client_action" ||
        action.type !== "integration" ||
        action.toolSlug !== "SHOPIFY_SEARCH_PRODUCTS" ||
        !Number.isFinite(page.expiresAt) ||
        page.expiresAt <= Date.now()
      )
        throw new Error(
          "This product page is no longer available. Search for the product again."
        )
      productSelectionInput = persistedContinuation.input as Record<
        string,
        unknown
      >
    } else {
      if (
        continuationType !== "client_action" ||
        action.type !== "integration" ||
        action.toolSlug !== "SHOPIFY_UPDATE_CART"
      )
        throw new Error("Invalid product selection.")
      productSelectionInput = selectedShopifyCartInput(
        interaction.input,
        persistedContinuation.shopifyProductSelection as NonNullable<
          RuntimeContinuation["shopifyProductSelection"]
        >
      )
    }
  }
  const reverifiedApproval =
    continuationType === "client_action" &&
    persistedContinuation.eventName === "Continue approved change" &&
    typeof persistedContinuation.shopifyApprovedSourceTurnId === "string" &&
    action.type === "integration" &&
    action.toolSlug.startsWith("SHOPIFY_")
  const approvalAllowed = trustedApproval || reverifiedApproval
  const shopifyConfirmed =
    continuationType === "client_action" &&
    persistedContinuation.eventName === "Confirm changes" &&
    action.type === "integration" &&
    shopifyActionNeedsConfirmation(action.toolSlug)
  const resumesShopifyCart =
    continuationType === "client_action" &&
    action.type === "integration" &&
    (isShopifyCartTool(action.toolSlug) ||
      action.toolSlug === "SHOPIFY_CREATE_ORDER") &&
    Boolean(persistedContinuation.shopifyCart)
  const approvedInput =
    productSelectionInput ??
    ((approvalAllowed || shopifyConfirmed || resumesShopifyCart) &&
    persistedContinuation &&
    typeof persistedContinuation.input === "object" &&
    !Array.isArray(persistedContinuation.input)
      ? (persistedContinuation.input as Record<string, unknown>)
      : interaction.input)
  return {
    input: approvedInput,
    options: {
      allowApproval: approvalAllowed,
      shopifyConfirmed,
      shopifyCartResult: resumesShopifyCart
        ? (interaction.input.cartResult ?? null)
        : undefined,
      shopifyReturnQuote: persistedContinuation.shopifyReturnQuote
        ? shopifyReturnQuoteSchema.parse(
            persistedContinuation.shopifyReturnQuote
          )
        : undefined,
      shopifyOrderQuote: persistedContinuation.shopifyOrderQuote
        ? shopifyOrderQuoteSchema.parse(persistedContinuation.shopifyOrderQuote)
        : undefined,
      // This continuation only exists after the pinned action's approval gate has passed.
      shopifyCartApproved:
        resumesShopifyCart &&
        action.type === "integration" &&
        isShopifyCartTool(action.toolSlug),
      shopifySourceTurnId: reverifiedApproval
        ? (persistedContinuation.shopifyApprovedSourceTurnId as string)
        : trustedApproval &&
            typeof persistedContinuation.shopifySourceTurnId === "string"
          ? persistedContinuation.shopifySourceTurnId
          : undefined,
      shopifyReverification: reverifiedApproval,
    },
  }
}

export type IntegrationContinuationState = {
  /** Server-owned source turn for a later merchant approval of a Shopify action. */
  shopifySourceTurnId?: string
  /** Approval already granted; only the original shopper may resume after verification. */
  shopifyApprovedSourceTurnId?: string
  shopifyCart?: { command: ShopifyCartCommand; expiresAt: number }
  shopifyProductSelection?: { variantIds: string[]; expiresAt: number }
  shopifyVariantPage?: { expiresAt: number }
  shopifyReturnQuote?: ShopifyReturnQuote
  shopifyOrderQuote?: ShopifyOrderQuote
}

export function inlineIntegrationContinuation(
  continuation: Record<string, unknown> | null | undefined
) {
  return Boolean(
    continuation?.shopifyProductSelection || continuation?.shopifyVariantPage
  )
}

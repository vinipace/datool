import { z } from "zod"

import {
  appendConversationMessageInputSchema,
  conversationPageSchema,
  createConversationInputSchema,
  startConversationTurnInputSchema,
} from "../conversation-schema"
import { createConversationService } from "../conversations"
import { runAgentTurn, runAgentTurnInputSchema } from "../runtime"
import { enqueueAgentTurnResult } from "../channels/service"
import { registerBuildOperation } from "../api"
import type { BuildContext } from "../context"
import { listConversationMessages } from "./inbox"

const id = z.string().trim().min(1).max(500)

function register(
  name: string,
  description: string,
  scopes: ("build:read" | "build:write" | "build:run")[],
  schema: z.ZodObject<z.ZodRawShape>,
  execute: (
    context: BuildContext & { requestKey?: string; idempotencyKey?: string },
    input: Record<string, unknown>
  ) => unknown,
  options: {
    destructive?: boolean
    idempotent?: boolean
    openWorld?: boolean
    idempotency?: "none" | "optional" | "required"
  } = {}
) {
  registerBuildOperation({
    name,
    description,
    scopes,
    schema,
    execute,
    ...options,
  })
}

register(
  "build_create_conversation",
  "Create or reuse a project-scoped customer conversation for an agent and channel.",
  ["build:write"],
  createConversationInputSchema,
  (context, input) =>
    createConversationService(context).getOrCreate(input as never),
  { idempotency: "optional" }
)
register(
  "build_get_conversation",
  "Read a customer conversation and its ownership state.",
  ["build:read"],
  z.object({ conversationId: id }),
  async (context, input) => {
    const conversation = await createConversationService(context).get(
      input.conversationId as string
    )
    if (!conversation)
      throw new Error(
        `Conversation '${input.conversationId as string}' was not found.`
      )
    return conversation
  }
)
register(
  "build_list_conversation_messages",
  "Read a bounded conversation transcript in chronological order.",
  ["build:read"],
  z.object({ conversationId: id }).extend(conversationPageSchema.shape),
  (context, input) =>
    listConversationMessages(context, input.conversationId as string, input)
)
register(
  "build_list_conversation_tools",
  "Read persisted tool calls and continuations for a conversation.",
  ["build:read"],
  z.object({ conversationId: id }),
  (context, input) =>
    createConversationService(context).listToolCalls(
      input.conversationId as string
    )
)
register(
  "build_append_conversation_message",
  "Append a durable customer, assistant, system, or tool message to a conversation.",
  ["build:write"],
  z.object({
    conversationId: id,
    message: appendConversationMessageInputSchema,
  }),
  (context, input) =>
    createConversationService(context).appendMessage(
      input.conversationId as string,
      input.message as never
    ),
  { idempotency: "optional" }
)
register(
  "build_start_conversation_turn",
  "Admit one idempotent conversation turn for a worker or channel adapter.",
  ["build:run"],
  z.object({
    conversationId: id,
    turn: startConversationTurnInputSchema.omit({ requestKey: true }),
  }),
  (context, input) => {
    const requestKey = context.requestKey ?? context.idempotencyKey
    if (!requestKey)
      throw new Error("A request key is required for a conversation turn.")
    return createConversationService(context).startTurn(
      input.conversationId as string,
      {
        ...(input.turn as Record<string, unknown>),
        requestKey,
      } as never
    )
  },
  { idempotency: "required" }
)
register(
  "build_run_agent_turn",
  "Run one guarded customer conversation turn through the managed agent runtime. Retries replay the durable result by request key.",
  ["build:run"],
  runAgentTurnInputSchema.omit({ requestKey: true }),
  (context, input) => {
    const requestKey = context.requestKey ?? context.idempotencyKey
    if (!requestKey)
      throw new Error("An idempotency key is required to run an agent turn.")
    return runAgentTurn(context, { ...input, requestKey } as never)
  },
  { openWorld: true, idempotency: "required" }
)
register(
  "build_approve_conversation_action",
  "Approve one pending guarded conversation action as the authenticated Build operator; the action input is read from its durable continuation.",
  ["build:run"],
  z.object({
    conversationId: id,
    actionId: id,
    continuationId: id,
  }),
  async (context, input) => {
    const requestKey = context.requestKey ?? context.idempotencyKey
    if (!requestKey)
      throw new Error(
        "An idempotency key is required to approve a conversation action."
      )
    const conversationService = createConversationService(context)
    const conversation = await conversationService.require(
      input.conversationId as string
    )
    const result = await runAgentTurn(
      context,
      {
        agentId: conversation.agentId,
        channel: conversation.channel,
        conversationId: conversation.id,
        requestKey,
        // The pending action input is loaded from the one-shot continuation;
        // this synthetic event carries no caller-controlled action arguments.
        message: "",
        metadata: {
          widgetInteraction: {
            actionId: input.actionId as string,
            continuationId: input.continuationId as string,
            input: {},
          },
        },
      },
      {
        trustedApproval: {
          actionId: input.actionId as string,
          continuationId: input.continuationId as string,
        },
      }
    )
    await enqueueAgentTurnResult(context, result, `operator:${requestKey}`)
    return result
  },
  { openWorld: true, idempotency: "required" }
)
register(
  "build_run_manual_procedure",
  "Run one enabled manual procedure for a conversation as the authenticated Build operator.",
  ["build:run"],
  z.object({
    conversationId: id,
    procedureId: id,
  }),
  async (context, input) => {
    const requestKey = context.requestKey ?? context.idempotencyKey
    if (!requestKey)
      throw new Error(
        "An idempotency key is required to run a manual procedure."
      )
    const conversation = await createConversationService(context).require(
      input.conversationId as string
    )
    const result = await runAgentTurn(
      context,
      {
        agentId: conversation.agentId,
        channel: conversation.channel,
        conversationId: conversation.id,
        requestKey,
        message: "",
        metadata: {},
      },
      {
        requiredProcedureId: input.procedureId as string,
        trustedMetadata: { procedureId: input.procedureId as string },
      }
    )
    await enqueueAgentTurnResult(context, result, `operator:${requestKey}`)
    return result
  },
  { openWorld: true, idempotency: "required" }
)
register(
  "build_resume_conversation_wait",
  "Resume one elapsed wait step in a conversation as the authenticated Build operator.",
  ["build:run"],
  z.object({
    conversationId: id,
    continuationId: id,
  }),
  async (context, input) => {
    const requestKey = context.requestKey ?? context.idempotencyKey
    if (!requestKey)
      throw new Error(
        "An idempotency key is required to resume a conversation wait."
      )
    const conversation = await createConversationService(context).require(
      input.conversationId as string
    )
    const result = await runAgentTurn(
      context,
      {
        agentId: conversation.agentId,
        channel: conversation.channel,
        conversationId: conversation.id,
        requestKey,
        message: "",
        metadata: {
          widgetInteraction: {
            actionId: "__wait__",
            continuationId: input.continuationId as string,
            input: {},
          },
        },
      },
      { trustedWaitContinuationId: input.continuationId as string }
    )
    await enqueueAgentTurnResult(context, result, `operator:${requestKey}`)
    return result
  },
  { openWorld: true, idempotency: "required" }
)
register(
  "build_get_conversation_turn",
  "Read one durable conversation turn and its replay or failure state.",
  ["build:read"],
  z.object({ turnId: id }),
  (context, input) =>
    createConversationService(context).getTurn(input.turnId as string)
)
register(
  "build_get_conversation_message",
  "Read one durable conversation message.",
  ["build:read"],
  z.object({ messageId: id }),
  (context, input) =>
    createConversationService(context).getMessage(input.messageId as string)
)
register(
  "build_set_conversation_variables",
  "Replace conversation variables while preserving project and ownership scope.",
  ["build:write"],
  z.object({
    conversationId: id,
    variables: z.record(z.string().max(200), z.json()),
    ownerFence: z.number().int().nonnegative().optional(),
  }),
  (context, input) =>
    createConversationService(context).setVariables(
      input.conversationId as string,
      input.variables as Record<string, unknown>,
      input.ownerFence as number | undefined
    ),
  { idempotency: "optional" }
)

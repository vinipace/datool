import { z } from "zod"

import type { BuildChannel } from "@/src/lib/build/contracts"
import { buildChannelSchema } from "@/src/lib/build/contracts"

/** Roles stored in the authoritative conversation ledger. */
export const conversationMessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
])
export type ConversationMessageRole = z.infer<
  typeof conversationMessageRoleSchema
>

export const conversationStatusSchema = z.enum([
  "active",
  "handed_off",
  "closed",
  "blocked",
])
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export const conversationOwnerTypeSchema = z.enum(["ai", "human"])
export type ConversationOwnerType = z.infer<typeof conversationOwnerTypeSchema>

export const conversationTurnStatusSchema = z.enum([
  "started",
  "running",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
  "awaiting_client",
])
export type ConversationTurnStatus = z.infer<
  typeof conversationTurnStatusSchema
>

export const conversationToolStatusSchema = z.enum([
  "planned",
  "executing",
  "completed",
  "failed",
  "awaiting_client",
  "uncertain",
])
export type ConversationToolStatus = z.infer<
  typeof conversationToolStatusSchema
>

export const conversationMessagePartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
  z.object({
    type: z.literal("image"),
    url: z.string().url().max(4096),
    alt: z.string().max(1000).optional(),
  }),
  z.object({
    type: z.literal("file"),
    url: z.string().url().max(4096),
    mimeType: z.string().max(200).optional(),
    name: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("action"),
    actionId: z.string().min(1).max(120),
    input: z.record(z.string(), z.json()).default({}),
  }),
  z.object({
    type: z.literal("widget"),
    widgetId: z.string().min(1).max(120),
    state: z.record(z.string(), z.json()).default({}),
  }),
])
export type ConversationMessagePart = z.infer<
  typeof conversationMessagePartSchema
>

export const conversationContentSchema = z.union([
  z.string().max(100_000),
  z.array(conversationMessagePartSchema).max(100),
  z.record(z.string(), z.json()),
])
export type ConversationContent = z.infer<typeof conversationContentSchema>

export const conversationMetadataSchema = z
  .record(z.string().max(200), z.json())
  .default({})
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>

export const createConversationInputSchema = z.object({
  agentId: z.string().min(1).max(200),
  channel: buildChannelSchema,
  externalConversationId: z.string().min(1).max(500).optional(),
  metadata: conversationMetadataSchema,
})
export type CreateConversationInput = z.infer<
  typeof createConversationInputSchema
>

export const appendConversationMessageInputSchema = z.object({
  role: conversationMessageRoleSchema,
  content: conversationContentSchema,
  turnId: z.string().min(1).max(200).optional(),
  toolCallId: z.string().max(200).optional(),
  actionId: z.string().max(120).optional(),
  status: z.enum(["pending", "completed", "failed", "cancelled"]).default(
    "completed"
  ),
  metadata: conversationMetadataSchema,
})
export type AppendConversationMessageInput = z.infer<
  typeof appendConversationMessageInputSchema
>

export const startConversationTurnInputSchema = z.object({
  requestKey: z.string().min(1).max(500),
  sourceEventId: z.string().max(500).optional(),
  snapshot: z.record(z.string(), z.json()).default({}),
  input: conversationContentSchema,
  metadata: conversationMetadataSchema,
})
export type StartConversationTurnInput = z.infer<
  typeof startConversationTurnInputSchema
>

export const conversationPageSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  before: z.string().optional(),
})

export const listConversationsInputSchema = z.object({
  agentId: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(256).optional(),
  search: z.string().max(300).optional(),
  status: conversationStatusSchema.optional(),
  channel: buildChannelSchema.optional(),
})

export type Conversation = {
  id: string
  projectId: string
  agentId: string
  channel: BuildChannel
  externalConversationId: string | null
  status: ConversationStatus
  ownerType: ConversationOwnerType
  ownerId: string | null
  ownerFence: number
  turnSequence: number
  metadata: ConversationMetadata
  variables: Record<string, unknown>
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

export type ConversationMessage = {
  id: string
  projectId: string
  conversationId: string
  turnId: string | null
  ordinal: number
  role: ConversationMessageRole
  content: ConversationContent
  toolCallId: string | null
  actionId: string | null
  status: "pending" | "completed" | "failed" | "cancelled"
  metadata: ConversationMetadata
  createdAt: string
  completedAt: string | null
}

export type ConversationTurn = {
  id: string
  projectId: string
  conversationId: string
  requestKey: string
  sourceEventId: string | null
  status: ConversationTurnStatus
  inputMessageId: string | null
  outputMessageId: string | null
  traceId: string | null
  sessionId: string | null
  snapshot: Record<string, unknown>
  usage: Record<string, unknown>
  error: Record<string, unknown> | null
  ownerFence: number
  lockExpiresAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export type ConversationToolCall = {
  id: string
  projectId: string
  conversationId: string
  turnId: string
  toolCallId: string
  actionId: string
  status: ConversationToolStatus
  input: Record<string, unknown>
  output: unknown
  error: Record<string, unknown> | null
  continuation: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
}

export type TurnAdmission = {
  kind: "created"
  conversation: Conversation
  turn: ConversationTurn
  inputMessage: ConversationMessage
  replay: false
} | {
  kind: "replay"
  conversation: Conversation
  turn: ConversationTurn
  outputMessage: ConversationMessage | null
  replay: true
} | {
  kind: "busy"
  conversation: Conversation
  turn: ConversationTurn
  replay: false
}

export type ConversationChannel = BuildChannel

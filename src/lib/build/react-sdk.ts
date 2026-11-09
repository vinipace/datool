import { z } from "zod"
import { scheduledTaskInputSchema } from "./schedules"

export const sdkScopeSchema = z.object({
  connectionId: z.string().uuid(),
  userId: z.string().trim().min(1).max(200),
  drive: z.string().trim().min(1).max(120).optional(),
})
export type SdkScope = z.infer<typeof sdkScopeSchema>
const conversation = z.string().min(1).max(200)
export const sdkChatRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("session"),
      threadId: z.string().min(1).max(200).default("default"),
    })
    .strict(),
  z
    .object({
      action: z.literal("messages"),
      conversationId: conversation,
      before: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("send"),
      conversationId: conversation,
      text: z.string().trim().min(1).max(20_000),
      requestId: z.string().uuid(),
    })
    .strict(),
])
export const sdkChatInputSchema = sdkScopeSchema
  .extend({ request: sdkChatRequestSchema })
  .strict()
export const sdkFileRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      path: z.string().max(1000).default(""),
    })
    .strict(),
  z
    .object({ action: z.literal("read"), path: z.string().min(1).max(1000) })
    .strict(),
  z
    .object({
      action: z.literal("write"),
      path: z.string().min(1).max(1000),
      content: z.string().max(350_000),
    })
    .strict(),
  z
    .object({ action: z.literal("mkdir"), path: z.string().min(1).max(1000) })
    .strict(),
  z
    .object({ action: z.literal("delete"), path: z.string().min(1).max(1000) })
    .strict(),
])
export const sdkFileInputSchema = sdkScopeSchema
  .extend({ request: sdkFileRequestSchema })
  .strict()
export const sdkTaskDefinitionSchema = scheduledTaskInputSchema.omit({
  agentId: true,
  channel: true,
})
const taskId = z.string().uuid()
export const sdkTaskRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      cursor: taskId.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("create"), task: sdkTaskDefinitionSchema })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id: taskId,
      expectedRevision: z.number().int().positive(),
      task: sdkTaskDefinitionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("pause"),
      id: taskId,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resume"),
      id: taskId,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      id: taskId,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal("run"), id: taskId }).strict(),
  z
    .object({
      action: z.literal("runs"),
      id: taskId,
      cursor: taskId.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
])
export const sdkTaskInputSchema = sdkScopeSchema
  .extend({ conversationId: conversation, request: sdkTaskRequestSchema })
  .strict()

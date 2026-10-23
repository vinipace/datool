import { z } from "zod"

import { chatBubbleOverridesSchema } from "./chat-bubble"
import { safeHttpUrlSchema } from "@/src/lib/build/urls"

/**
 * Channel contracts are deliberately provider-neutral. Providers translate to
 * these envelopes at the edge; the agent runtime never needs to know whether a
 * turn came from a browser, Telegram or a future inbox adapter.
 */
export const channelIdSchema = z.enum([
  "web",
  "telegram",
  "whatsapp",
  "messenger",
  "instagram",
  "email",
  "slack",
  "api",
  "helpdesk",
])
export type ChannelId = z.infer<typeof channelIdSchema>

export const channelStatusSchema = z.enum([
  "draft",
  "connected",
  "paused",
  "error",
  "disconnected",
])
export type ChannelStatus = z.infer<typeof channelStatusSchema>

export type ChannelCapability =
  | "receive_text"
  | "receive_media"
  | "send_text"
  | "send_media"
  | "buttons"
  | "forms"
  | "typing"
  | "read_receipts"
  | "human_handoff"
  | "webhook"
  | "polling"

export type ChannelDescriptor = {
  id: ChannelId
  label: string
  capabilities: readonly ChannelCapability[]
  /** Provider-specific connection setup, never returned with credentials. */
  connectionSchema: z.ZodTypeAny
}

export type ChannelConnection = {
  id: string
  projectId: string
  organizationId: string | null
  agentId: string
  channel: ChannelId
  label: string
  status: ChannelStatus
  externalId: string | null
  config: Record<string, unknown>
  lastError: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  createdAt: string
  updatedAt: string
}

export const normalizedAttachmentSchema = z
  .object({
    type: z.enum([
      "image",
      "audio",
      "video",
      "document",
      "location",
      "unknown",
    ]),
    url: safeHttpUrlSchema.max(4_096).optional(),
    fileId: z.string().max(4_096).optional(),
    mimeType: z.string().max(512).optional(),
    name: z.string().max(2_048).optional(),
    caption: z.string().max(100_000).optional(),
    metadata: z.record(z.string().max(120), z.unknown()).optional(),
  })
  .passthrough()
export type NormalizedAttachment = z.infer<typeof normalizedAttachmentSchema>

export type InboundEnvelope = {
  connectionId: string
  channel: ChannelId
  providerEventId: string
  providerMessageId: string
  externalConversationId: string
  externalContactId: string
  receivedAt: string
  text: string
  attachments: NormalizedAttachment[]
  contact: {
    externalId: string
    displayName?: string
    username?: string
    phone?: string
    locale?: string
    metadata?: Record<string, unknown>
  }
  metadata: Record<string, unknown>
}

export type OutboundEnvelope = {
  connectionId: string
  conversationId: string
  /** Contact owning this message, when the channel adapter can resolve it. */
  contactId?: string
  channel: ChannelId
  idempotencyKey: string
  text: string
  attachments?: NormalizedAttachment[]
  replyToProviderMessageId?: string
  metadata?: Record<string, unknown>
}

export type AgentTurnInput = {
  projectId: string
  agentId: string
  conversationId: string
  channel: ChannelId
  contactId: string
  messages: Array<{
    role: "user" | "assistant" | "system"
    content: string
    attachments?: NormalizedAttachment[]
  }>
  metadata: Record<string, unknown>
}

export type AgentTurnOutput = {
  /** Ownership epoch of the admitted runtime turn, after it advances the ledger. */
  ownerFence?: number
  /** Owner type for the admitted epoch. A handoff response must carry `human`. */
  ownerType?: "ai" | "human"
  messages: Array<{
    text: string
    attachments?: NormalizedAttachment[]
    metadata?: Record<string, unknown>
  }>
  ownership?: "ai" | "human"
  metadata?: Record<string, unknown>
}

export type AgentTurnRunner = (
  input: AgentTurnInput
) => Promise<AgentTurnOutput>

const connectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  organizationId: z.string().nullable(),
  agentId: z.string().min(1),
  channel: channelIdSchema,
  label: z.string(),
  status: channelStatusSchema,
  externalId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  lastOutboundAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Never return provider credentials, webhook secrets or encrypted blobs. */
export function publicChannelConnection(value: ChannelConnection) {
  const parsed = connectionSchema.parse(value)
  return {
    id: parsed.id,
    projectId: parsed.projectId,
    organizationId: parsed.organizationId,
    agentId: parsed.agentId,
    channel: parsed.channel,
    label: parsed.label,
    status: parsed.status,
    externalId: parsed.externalId,
    config: redactConfig(parsed.config),
    lastError: parsed.lastError,
    lastInboundAt: parsed.lastInboundAt,
    lastOutboundAt: parsed.lastOutboundAt,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  }
}

/**
 * Redacts credential-shaped values at every level of a provider config.
 * Config is JSON from the database, so preserving arrays and objects here is
 * safe and keeps the public connection shape useful to the UI while ensuring
 * a provider cannot smuggle a nested cookie or private key into a response.
 */
export function redactConfig(config: Record<string, unknown>) {
  const secret =
    /token|secret|password|credential|api[-_]?key|authorization|cookie|private[-_]?key/i
  const redact = (key: string | undefined, value: unknown): unknown => {
    if (key && secret.test(key)) return "[redacted]"
    if (Array.isArray(value))
      return value.map((item) => redact(undefined, item))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([nestedKey, nestedValue]) => [
            nestedKey,
            redact(nestedKey, nestedValue),
          ]
        )
      )
    }
    return value
  }
  return redact(undefined, config) as Record<string, unknown>
}

export function timingSafeStringEquals(left: string, right: string) {
  // This comparison is deliberately independent of a provider credential.
  // The server-side HMAC wrapper uses this helper after hashing its inputs.
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index++)
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  return difference === 0
}

/** Signed visitor context for public web sessions. Contains no server secret. */
export type VisitorContext = {
  browserSessionId?: string
  identityVersion?: number
  visitorId: string
  /** Binds a bearer visitor token to one hosted channel deployment. */
  connectionId?: string
  issuedAt: number
  expiresAt: number
  origin?: string
  metadata?: Record<string, string>
}

export const CHANNEL_DESCRIPTORS: Record<ChannelId, ChannelDescriptor> = {
  web: {
    id: "web",
    label: "Chat Bubble",
    capabilities: ["receive_text", "send_text", "human_handoff"],
    connectionSchema: z.object({
      originAllowlist: z.array(z.string().url()).default([]),
      shopifyShop: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)
        .max(253)
        .optional(),
      bubble: chatBubbleOverridesSchema.optional(),
      publicAdmission: z
        .object({
          visitorMessagesPerMinute: z.number().int().min(1).max(120).optional(),
          visitorMessagesPerDay: z
            .number()
            .int()
            .min(1)
            .max(10000)
            .nullable()
            .optional(),
          session: z
            .object({
              maxRequests: z.number().int().min(1).max(10_000).optional(),
              windowSeconds: z.number().int().min(10).max(3_600).optional(),
            })
            .optional(),
          message: z
            .object({
              maxRequests: z.number().int().min(1).max(10_000).optional(),
              windowSeconds: z.number().int().min(10).max(3_600).optional(),
            })
            .optional(),
          feedback: z
            .object({
              maxRequests: z.number().int().min(1).max(10_000).optional(),
              windowSeconds: z.number().int().min(10).max(3_600).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  },
  telegram: {
    id: "telegram",
    label: "Telegram",
    capabilities: [
      "receive_text",
      "receive_media",
      "send_text",
      "send_media",
      "webhook",
      "polling",
      "human_handoff",
    ],
    connectionSchema: z.object({
      mode: z.enum(["webhook", "polling"]).default("webhook"),
    }),
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    capabilities: [
      "receive_text",
      "receive_media",
      "send_text",
      "send_media",
      "webhook",
      "read_receipts",
      "human_handoff",
    ],
    connectionSchema: z.object({}).strict(),
  },
  messenger: {
    id: "messenger",
    label: "Messenger",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
  email: {
    id: "email",
    label: "Email",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
  slack: {
    id: "slack",
    label: "Slack",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
  api: {
    id: "api",
    label: "API",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
  helpdesk: {
    id: "helpdesk",
    label: "Helpdesk",
    capabilities: [],
    connectionSchema: z.record(z.string(), z.unknown()),
  },
}

export type ChannelRegistry = {
  get(channel: ChannelId): ChannelDescriptor
  list(): ChannelDescriptor[]
}

export function createChannelRegistry(
  descriptors: Record<ChannelId, ChannelDescriptor> = CHANNEL_DESCRIPTORS
): ChannelRegistry {
  return {
    get(channel) {
      const descriptor = descriptors[channel]
      if (!descriptor) throw new Error(`Unsupported channel: ${channel}`)
      return descriptor
    },
    list: () => Object.values(descriptors),
  }
}

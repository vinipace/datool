import { z } from "zod"
import { widgetTranslationsSchema } from "./widget-i18n"
import { shopifyActionSettingsSchema } from "./shopify"

import type { JsonValue } from "@/src/lib/tracer/contracts"
import { safeHttpUrlSchema } from "@/src/lib/build/urls"

/** Supported delivery channels. New adapters can be added without changing an agent's core contract. */
export const buildChannelSchema = z.enum([
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
export type BuildChannel = z.infer<typeof buildChannelSchema>

export const agentProviderSchema = z.enum(["project", "gateway", "openai"])
export type AgentProvider = z.infer<typeof agentProviderSchema>

export const agentChannelOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  instructions: z.string().max(32_000).optional(),
  /** Optional channel credential route; omitted values inherit the agent provider. */
  provider: agentProviderSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
})
export type AgentChannelOverride = z.infer<typeof agentChannelOverrideSchema>

export const agentAvatarStyleSchema = z.enum([
  "friendly",
  "happy",
  "wink",
  "calm",
])
export const agentAvatarColorSchema = z.enum([
  "orange",
  "violet",
  "blue",
  "green",
  "rose",
  "yellow",
])

export const agentAppearanceSchema = z.object({
  displayName: z.string().min(1).max(160).default("Assistant"),
  avatarUrl: safeHttpUrlSchema.max(2_048).nullable().default(null),
  avatarStyle: agentAvatarStyleSchema.default("friendly"),
  avatarColor: agentAvatarColorSchema.default("orange"),
  welcomeMessage: z.string().max(4_000).default(""),
  suggestedReplies: z.array(z.string().min(1).max(300)).max(12).default([]),
  inputPlaceholder: z.string().max(300).default("Message your assistant"),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#111111"),
})
export type AgentAppearance = z.infer<typeof agentAppearanceSchema>

export const agentGuardrailsSchema = z.object({
  maxInputCharacters: z.number().int().min(1).max(100_000).default(20_000),
  maxOutputTokens: z.number().int().min(1).max(64_000).default(4_000),
  maxTurns: z.number().int().min(1).max(200).default(50),
  blockedTopics: z.array(z.string().min(1).max(500)).max(200).default([]),
  blockedCountries: z
    .array(z.string().length(2).toUpperCase())
    .max(250)
    .default([]),
  spamAfterMessages: z.number().int().min(2).max(100).nullable().default(null),
  requireHumanForActions: z.boolean().default(false),
  requestsPerMinute: z.number().int().min(1).max(100_000).default(60),
  maxConcurrentTurns: z.number().int().min(1).max(1_000).default(20),
  dailyTurnLimit: z
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .nullable()
    .default(null),
  dailyBudgetUsd: z.number().min(0).max(1_000_000).nullable().default(null),
})
export type AgentGuardrails = z.infer<typeof agentGuardrailsSchema>

export const agentConfigurationSchema = z.object({
  instructions: z.string().max(64_000).default(""),
  provider: agentProviderSchema.default("project"),
  model: z.string().min(1).max(200).default("openai/gpt-4.1-mini"),
  temperature: z.number().min(0).max(2).default(0.2),
  /** Channels on which this agent is allowed to receive and answer turns. */
  channelAllowlist: z
    .array(buildChannelSchema)
    .min(1)
    .max(20)
    .default([
      "web",
      "telegram",
      "whatsapp",
      "messenger",
      "instagram",
      "email",
      "slack",
      "api",
      "helpdesk",
    ]),
  channelOverrides: z
    .partialRecord(buildChannelSchema, agentChannelOverrideSchema)
    .default({}),
  appearance: agentAppearanceSchema.default({
    displayName: "Assistant",
    avatarUrl: null,
    avatarStyle: "friendly",
    avatarColor: "orange",
    welcomeMessage: "",
    suggestedReplies: [],
    inputPlaceholder: "Message your assistant",
    primaryColor: "#111111",
  }),
  guardrails: agentGuardrailsSchema.default({
    maxInputCharacters: 20_000,
    maxOutputTokens: 4_000,
    maxTurns: 50,
    blockedTopics: [],
    blockedCountries: [],
    spamAfterMessages: null,
    requireHumanForActions: false,
    requestsPerMinute: 60,
    maxConcurrentTurns: 20,
    dailyTurnLimit: null,
    dailyBudgetUsd: null,
  }),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>

export type AgentStatus = "active" | "archived"

export type ManagedAgent = {
  id: string
  projectId: string
  slug: string
  name: string
  description: string | null
  status: AgentStatus
  currentRevision: number
  appliedRevision: number
  configuration: AgentConfiguration
  /** The immutable configuration currently authorized for customer runtime execution. */
  appliedConfiguration?: AgentConfiguration
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export type AgentRevision = {
  id: string
  projectId: string
  agentId: string
  revision: number
  configuration: AgentConfiguration
  state: "draft" | "applied"
  createdAt: string
  createdBy: string | null
}

export type SaveAgentInput = {
  name?: string
  slug?: string
  description?: string | null
  configuration?: unknown
  expectedRevision: number
  apply?: boolean
}

export const actionTypeSchema = z.enum([
  "integration",
  "http",
  "client",
  "widget",
  "form",
  "handoff",
])
export type ActionType = z.infer<typeof actionTypeSchema>

const actionBaseSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).default(""),
  enabled: z.boolean().default(true),
  channels: z
    .array(buildChannelSchema)
    .max(20)
    .default([
      "web",
      "telegram",
      "whatsapp",
      "messenger",
      "instagram",
      "email",
      "slack",
      "api",
      "helpdesk",
    ]),
  procedureOnly: z.boolean().default(false),
  inputSchema: z.record(z.string(), z.json()).default({}),
})

export const actionDefinitionSchema = z.discriminatedUnion("type", [
  actionBaseSchema.extend({
    type: z.literal("integration"),
    connectionId: z.string().uuid(),
    toolSlug: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .max(200),
    shopifySettings: shopifyActionSettingsSchema.optional(),
  }),
  actionBaseSchema.extend({
    type: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().url().max(4_096),
    headers: z.record(z.string().max(200), z.string().max(4_000)).default({}),
    bodyTemplate: z.string().max(64_000).nullable().default(null),
    responseSchema: z.record(z.string(), z.json()).default({}),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  }),
  actionBaseSchema.extend({
    type: z.literal("client"),
    eventName: z.string().min(1).max(200),
    resultSchema: z.record(z.string(), z.json()).default({}),
  }),
  actionBaseSchema.extend({
    type: z.literal("widget"),
    widgetId: z.string().min(1).max(120),
    eventName: z.string().min(1).max(200),
    resultSchema: z.record(z.string(), z.json()).default({}),
  }),
  actionBaseSchema.extend({
    type: z.literal("form"),
    captureLead: z.boolean().default(false),
    submitLabel: z.string().min(1).max(120).default("Submit"),
    translations: widgetTranslationsSchema.optional(),
    fields: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          label: z.string().min(1).max(200),
          type: z.enum([
            "text",
            "email",
            "phone",
            "number",
            "select",
            "textarea",
            "checkbox",
          ]),
          required: z.boolean().default(false),
          options: z.array(z.string().max(300)).max(100).default([]),
        })
      )
      .max(100),
    submitActionId: z.string().min(1).max(120).nullable().default(null),
  }),
  actionBaseSchema.extend({
    type: z.literal("handoff"),
    teamId: z.string().min(1).max(120).nullable().default(null),
    message: z.string().max(2_000).default("I'll connect you with a teammate."),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  }),
])
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>

export type ActionRecord = {
  id: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definition: ActionDefinition
  createdAt: string
  updatedAt: string
}

export const procedureTriggerSchema = z.object({
  type: z.enum(["keyword", "intent", "event", "manual"]),
  value: z.string().min(1).max(500),
})
export type ProcedureTrigger = z.infer<typeof procedureTriggerSchema>

export const procedureStepSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(120),
    kind: z.literal("message"),
    content: z.string().min(1).max(16_000),
  }),
  z.object({
    id: z.string().min(1).max(120),
    kind: z.literal("action"),
    actionId: z.string().min(1).max(120),
    input: z.record(z.string(), z.json()).default({}),
  }),
  z.object({
    id: z.string().min(1).max(120),
    kind: z.literal("set_variable"),
    name: z.string().min(1).max(120),
    value: z.json(),
  }),
  z.object({
    id: z.string().min(1).max(120),
    kind: z.literal("wait"),
    seconds: z.number().int().min(0).max(86_400),
  }),
  z.object({
    id: z.string().min(1).max(120),
    kind: z.literal("handoff"),
    actionId: z.string().min(1).max(120),
  }),
])
export type ProcedureStep = z.infer<typeof procedureStepSchema>

export const procedureDefinitionSchema = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(2_000).default(""),
    enabled: z.boolean().default(true),
    trigger: procedureTriggerSchema,
    instructions: z.string().max(32_000).optional(),
    variables: z.record(z.string().max(120), z.json()).default({}),
    steps: z.array(procedureStepSchema).max(15).default([]),
    branches: z
      .array(
        z.object({
          id: z.string().min(1).max(120),
          condition: z.string().min(1).max(2_000),
          steps: z.array(procedureStepSchema).max(15),
        })
      )
      .max(5)
      .default([]),
    actionRefs: z.array(z.string().min(1).max(120)).max(100).default([]),
  })
  .superRefine((definition, context) => {
    const hasInstructions = Boolean(definition.instructions?.trim())
    if (!hasInstructions && !definition.steps.length)
      context.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "Add skill instructions or at least one structured step.",
      })
    if (
      hasInstructions &&
      (definition.steps.length || definition.branches.length)
    )
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Use skill instructions or structured steps, not both.",
      })
  })

export type ProcedureDefinition = z.infer<typeof procedureDefinitionSchema>

export type ProcedureRecord = {
  id: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definition: ProcedureDefinition
  createdAt: string
  updatedAt: string
}

export const widgetComponentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(8_000) }),
  z.object({
    type: z.literal("button"),
    label: z.string().min(1).max(200),
    actionId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal("form"),
    fields: z.array(z.string().min(1).max(120)).max(100),
    submitActionId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal("list"),
    itemsPath: z.string().min(1).max(500),
    itemTemplate: z.string().max(4_000),
  }),
  z.object({
    type: z.literal("card"),
    title: z.string().max(500),
    body: z.string().max(4_000),
    actionId: z.string().min(1).max(120).nullable().default(null),
  }),
])
export type WidgetComponent = z.infer<typeof widgetComponentSchema>

export const widgetDefinitionSchema = z
  .object({
    translations: widgetTranslationsSchema.optional(),
    name: z.string().min(1).max(160),
    description: z.string().max(2_000).default(""),
    enabled: z.boolean().default(true),
    code: z.string().trim().min(1).max(100_000).optional(),
    schemaCode: z.string().trim().min(1).max(100_000).optional(),
    components: z.array(widgetComponentSchema).max(100).default([]),
    states: z
      .record(z.string().max(120), z.record(z.string(), z.json()))
      .default({}),
    functions: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          inputSchema: z.record(z.string(), z.json()).default({}),
          outputSchema: z.record(z.string(), z.json()).default({}),
          actionId: z.string().min(1).max(120).nullable().default(null),
        })
      )
      .max(100)
      .default([]),
  })
  .refine((widget) => Boolean(widget.code) || widget.components.length > 0, {
    message: "Provide widget JSX code or legacy components.",
    path: ["code"],
  })
export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>

export type WidgetRecord = {
  id: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definition: WidgetDefinition
  createdAt: string
  updatedAt: string
}

export type BuildJson = JsonValue

/**
 * Customer-operation channels. The registry is deliberately data driven so a
 * channel adapter can be added without changing contact, inbox, or campaign
 * persistence. Telegram is the first enabled delivery adapter.
 */
export const operationsChannelSchema = z.enum([
  "telegram",
  "web",
  "whatsapp",
  "messenger",
  "instagram",
  "email",
  "slack",
  "api",
])
export type OperationsChannel = z.infer<typeof operationsChannelSchema>

export type ChannelCapability = {
  inbound: boolean
  outbound: boolean
  campaigns: boolean
  richMedia: boolean
  humanHandoff: boolean
}

export const OPERATIONS_CHANNEL_CAPABILITIES: Record<
  OperationsChannel,
  ChannelCapability
> = {
  telegram: {
    inbound: true,
    outbound: true,
    campaigns: true,
    richMedia: true,
    humanHandoff: true,
  },
  web: {
    inbound: false,
    outbound: true,
    campaigns: false,
    richMedia: true,
    humanHandoff: true,
  },
  whatsapp: {
    inbound: true,
    outbound: true,
    campaigns: false,
    richMedia: true,
    humanHandoff: true,
  },
  messenger: {
    inbound: false,
    outbound: false,
    campaigns: false,
    richMedia: true,
    humanHandoff: false,
  },
  instagram: {
    inbound: false,
    outbound: false,
    campaigns: false,
    richMedia: true,
    humanHandoff: false,
  },
  email: {
    inbound: false,
    outbound: false,
    campaigns: false,
    richMedia: false,
    humanHandoff: true,
  },
  slack: {
    inbound: false,
    outbound: false,
    campaigns: false,
    richMedia: false,
    humanHandoff: true,
  },
  api: {
    inbound: true,
    outbound: true,
    campaigns: false,
    richMedia: true,
    humanHandoff: true,
  },
}

export function getOperationsChannelCapabilities(channel: OperationsChannel) {
  return OPERATIONS_CHANNEL_CAPABILITIES[channel]
}

export function assertOperationsChannelCapability(
  channel: OperationsChannel,
  capability: keyof ChannelCapability
) {
  if (!OPERATIONS_CHANNEL_CAPABILITIES[channel][capability]) {
    throw new Error(
      `The ${channel} channel does not support ${capability} in this deployment.`
    )
  }
}

export const operationsPageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(256).optional(),
})
export type OperationsPage = z.infer<typeof operationsPageSchema>

export const contactStatusSchema = z.enum(["active", "blocked", "archived"])
export type ContactStatus = z.infer<typeof contactStatusSchema>

export const contactInputSchema = z.object({
  externalId: z.string().trim().min(1).max(256).optional(),
  displayName: z.string().trim().max(300).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().trim().max(80).optional(),
  status: contactStatusSchema.default("active"),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
export type ContactInput = z.infer<typeof contactInputSchema>

export const contactIdentityInputSchema = z.object({
  contactId: z.string().min(1).max(128),
  channel: operationsChannelSchema,
  identityKey: z.string().trim().min(1).max(512),
  displayName: z.string().trim().max(300).optional(),
  verified: z.boolean().default(false),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
export type ContactIdentityInput = z.infer<typeof contactIdentityInputSchema>

export const ticketStatusSchema = z.enum([
  "open",
  "pending",
  "snoozed",
  "solved",
  "closed",
])
export type TicketStatus = z.infer<typeof ticketStatusSchema>
export const ticketPrioritySchema = z.enum(["low", "normal", "high", "urgent"])
export type TicketPriority = z.infer<typeof ticketPrioritySchema>

export const ticketInputSchema = z.object({
  conversationId: z.string().trim().min(1).max(256),
  contactId: z.string().trim().min(1).max(128).optional(),
  channel: operationsChannelSchema.default("telegram"),
  subject: z.string().trim().max(500).optional(),
  status: ticketStatusSchema.default("open"),
  priority: ticketPrioritySchema.default("normal"),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
})
export type TicketInput = z.infer<typeof ticketInputSchema>

export const teamInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  enabled: z.boolean().default(true),
  memberIds: z.array(z.string().min(1).max(128)).max(500).optional(),
})
export type TeamInput = z.infer<typeof teamInputSchema>

export const routingRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  priority: z.number().int().min(0).max(1_000).default(100),
  enabled: z.boolean().default(true),
  conditions: z.record(z.string().max(120), z.json()).default({}),
  teamId: z.string().min(1).max(128).nullable().default(null),
  assigneeUserId: z.string().min(1).max(128).nullable().default(null),
})
export type RoutingRuleInput = z.infer<typeof routingRuleInputSchema>

export const macroActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_status"), status: ticketStatusSchema }),
  z.object({ type: z.literal("set_priority"), priority: ticketPrioritySchema }),
  z.object({
    type: z.literal("add_tag"),
    tag: z.string().trim().min(1).max(80),
  }),
  z.object({
    type: z.literal("remove_tag"),
    tag: z.string().trim().min(1).max(80),
  }),
  z.object({
    type: z.literal("assign_team"),
    teamId: z.string().trim().min(1).max(128),
  }),
  z.object({
    type: z.literal("assign_user"),
    userId: z.string().trim().min(1).max(128),
  }),
  z.object({ type: z.literal("clear_assignment") }),
  z.object({
    type: z.literal("snooze_until"),
    snoozeUntil: z.string().datetime(),
  }),
])
export type MacroAction = z.infer<typeof macroActionSchema>
export const macroInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  body: z.string().min(1).max(16_000),
  actions: z.array(macroActionSchema).max(50).default([]),
  enabled: z.boolean().default(true),
})
export type MacroInput = z.infer<typeof macroInputSchema>

export const csatSubmissionSchema = z.object({
  surveyId: z.string().min(1).max(128),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(4_000).default(""),
})
export type CsatSubmission = z.infer<typeof csatSubmissionSchema>

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: operationsChannelSchema.default("telegram"),
  /** Provider connection used by the delivery worker; optional for drafts. */
  connectionId: z.string().trim().min(1).max(128).optional(),
  template: z.record(z.string().max(120), z.json()).default({}),
  audienceFilter: z.record(z.string().max(120), z.json()).default({}),
  suppressionFilter: z.record(z.string().max(120), z.json()).default({}),
  scheduledAt: z.string().datetime().nullable().default(null),
})
export type CampaignInput = z.infer<typeof campaignInputSchema>

export const operationEventInputSchema = z.object({
  eventType: z.enum([
    "message_received",
    "message_sent",
    "agent_failed",
    "tool_failed",
    "low_feedback",
    "handoff",
    "ticket_created",
    "ticket_resolved",
    "csat_submitted",
    "campaign_sent",
    "campaign_delivered",
    "campaign_replied",
  ]),
  conversationId: z.string().max(256).optional(),
  contactId: z.string().max(128).optional(),
  channel: operationsChannelSchema.optional(),
  payload: z.record(z.string().max(200), z.json()).default({}),
  occurredAt: z.string().datetime().optional(),
})
export type OperationEventInput = z.infer<typeof operationEventInputSchema>

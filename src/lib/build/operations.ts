import { z } from "zod"

/**
 * Customer-operations contracts live behind this module boundary. The
 * definitions currently remain re-exported from contracts.ts for compatibility
 * with the Build registry and existing pages while integrations migrate to the
 * operations namespace.
 */
export {
  OPERATIONS_CHANNEL_CAPABILITIES,
  assertOperationsChannelCapability,
  campaignInputSchema,
  contactIdentityInputSchema,
  contactInputSchema,
  contactStatusSchema,
  csatSubmissionSchema,
  getOperationsChannelCapabilities,
  macroActionSchema,
  macroInputSchema,
  operationsChannelSchema,
  operationsPageSchema,
  operationEventInputSchema,
  routingRuleInputSchema,
  teamInputSchema,
  ticketInputSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
} from "./contracts"

export type {
  BuildJson,
  ChannelCapability,
  ContactIdentityInput,
  ContactInput,
  ContactStatus,
  CsatSubmission,
  MacroInput,
  MacroAction,
  OperationsChannel,
  OperationsPage,
  OperationEventInput,
  RoutingRuleInput,
  TeamInput,
  TicketInput,
  TicketPriority,
  TicketStatus,
} from "./contracts"

/** Queue states shared by the Build worker health MCP surface. */
export type BuildQueueHealth = {
  backlog: number
  oldestJobAt: string | null
  failed: number
  uncertain: number
}

export type BuildHealth = {
  projectId: string
  generatedAt: string
  status: "healthy" | "degraded" | "blocked"
  totalBacklog: number
  totalFailed: number
  totalUncertain: number
  queues: {
    knowledge: BuildQueueHealth
    channel: BuildQueueHealth
    simulation: BuildQueueHealth
    campaign: BuildQueueHealth
  }
}

export type BuildDeliveryFailure = {
  jobId: string
  messageId: string | null
  connectionId: string
  kind: "process_inbound" | "deliver_outbound" | "telegram_poll"
  channel: string | null
  status: "failed" | "uncertain"
  attempts: number
  runAfter: string | null
  createdAt: string | null
  updatedAt: string | null
  messageStatus: string | null
  direction: string | null
  failureCode: string
  retryAllowed: boolean
}

/** Explicit retries are limited to deterministic pre-send failures. */
export const safeDeliveryRetryCodes = [
  "INVALID_CREDENTIAL",
  "UNSUPPORTED_ATTACHMENT",
] as const
export const safeDeliveryRetryCodeSchema = z.enum(safeDeliveryRetryCodes)
export type SafeDeliveryRetryCode = z.infer<typeof safeDeliveryRetryCodeSchema>

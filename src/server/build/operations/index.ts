import { getWhatsAppDelivery, getWhatsAppMedia } from "../channels/whatsapp"
import { z } from "zod"
import { metaIdSchema, whatsappModeSchema, whatsappRecipientSchema, whatsappTemplateSchema } from "@/src/lib/build/whatsapp"
import { getWhatsAppSetup, getWhatsAppConnection, beginWhatsAppSignup, getWhatsAppSignup, authorizeWhatsAppSignup, activateWhatsAppSignup, refreshWhatsAppConnection, disconnectWhatsApp, listWhatsAppTemplates, createWhatsAppTemplate, deleteWhatsAppTemplate, getWhatsAppRecipient, setWhatsAppConsent, sendWhatsAppTemplate, syncWhatsAppApp } from "../channels/whatsapp"
import { chatBubbleOverridesSchema } from "@/src/lib/build/chat-bubble"

import {
  registerBuildOperation,
} from "../api"
import {
  archiveAgent,
  cloneAgent,
  createAgent,
  getAgent,
  listAgentRevisions,
  listAgents,
  restoreAgentRevision,
  updateAgent,
} from "../agents"
import {
  deleteAction,
  deleteProcedure,
  deleteWidget,
  getAction,
  getProcedure,
  getWidget,
  listActionRevisions,
  listActions,
  listProcedureRevisions,
  listProcedures,
  listWidgetRevisions,
  listWidgets,
  saveAction,
  saveProcedure,
  saveWidget,
} from "../definitions"
import {
  createKnowledgeSourceSchema,
  updateKnowledgeSourceSchema,
  knowledgeJobKindSchema,
} from "@/src/lib/build/knowledge"
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  enqueueKnowledgeIndex,
  exportKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeSources,
  previewKnowledgeSource,
  retrieveKnowledge,
  runKnowledgeJob,
  runQueuedKnowledgeJobs,
  updateKnowledgeSource,
} from "../knowledge/service"
import { getKnowledgePage, listKnowledgePages } from "../knowledge/pages"
import {
  createChannelConnection,
  enqueueOutboundEnvelope,
  enqueueTelegramPollingJobs,
  getChannelConnection,
  listChannelConnections,
  registerTelegramConnection,
  unregisterTelegramConnection,
  updateChannelStatus,
  updateChannelConnection,
} from "../channels/service"
import { buildChannelSchema, macroActionSchema, teamInputSchema } from "@/src/lib/build/contracts"
import { safeDeliveryRetryCodes } from "@/src/lib/build/operations"
import {
  collectData,
  createContact,
  exportContacts,
  getContact,
  importContacts,
  listCollectedData,
  listContactAttributes,
  listContactIdentities,
  listContacts,
  listLeads,
  requestContactExport,
  setContactAttribute,
  updateContact,
  upsertContactIdentity,
  upsertLead,
} from "./contacts"
import {
  contactInputSchema,
  contactIdentityInputSchema,
  operationsPageSchema,
} from "@/src/lib/build/contracts"
import type { BuildContext } from "../context"

// Keep the conversation/runtime registry split by feature so additions do not
// bypass the shared Build operation metadata and transport registration.
import "./conversations"
import {
  addTicketNote,
  assignTicket,
  createTicket,
  getConversationOwnership,
  getTicket,
  listCsat,
  listTicketEvents,
  listTicketNotes,
  listTickets,
  requestCsat,
  resumeConversation,
  sendHumanReply,
  submitCsat,
  takeoverConversation,
  updateTicket,
} from "./inbox"
import {
  createMacro,
  createRoutingRule,
  createTeam,
  applyMacro,
  listMacros,
  listRoutingRules,
  listTeams,
  listOrganizationMembers,
  resolveRouting,
  setAgentAvailability,
  setTeamMember,
  updateMacro,
  updateTeam,
} from "./teams"
import {
  acknowledgeCampaignDelivery,
  claimCampaignDeliveries,
  createCampaign,
  getCampaign,
  listCampaigns,
  listCampaignDeliveries,
  processNextCampaignDelivery,
  queueCampaignDeliveries,
  runCampaign,
  setCampaignStatus,
  snapshotCampaignAudience,
  suppressCampaignContact,
  updateCampaign,
} from "./campaigns"
import {
  getOperationalAnalytics,
  listKnowledgeGapSuggestions,
  recordFeedback,
  recordOperationEvent,
  refreshKnowledgeGapSuggestions,
  updateKnowledgeGapStatus,
} from "./analytics"
import {
  getBuildHealth,
  listDeliveryFailures,
  retryDelivery,
} from "./health"
import {
  addSimulationToolMock,
  archiveSimulationDefinition,
  cancelSimulationRun,
  createSimulationDefinition,
  getSimulationDefinition,
  getSimulationRun,
  listSimulationCases,
  listSimulationDefinitionRevisions,
  listSimulationDefinitions,
  listSimulationRuns,
  listSimulationToolMocks,
  recoverSimulationRun,
  startSimulationRun,
  updateSimulationDefinition,
} from "../testing/service"
import {
  applyCopilotProposal,
  approveCopilotProposal,
  createCopilotProposal,
  defaultCopilotGenerator,
  getCopilotProposal,
  listCopilotAudit,
  listCopilotProposals,
  rejectCopilotProposal,
} from "../copilot/service"
import {
  copilotProposalInputSchema,
  simulationDefinitionSchema,
  toolMockSchema,
} from "@/src/lib/build/testing"

const id = z.string().trim().min(1).max(200)
const agentId = z.object({ agentId: id })
const revision = z.object({ expectedRevision: z.number().int().positive() })
const definition = z.record(z.string().max(120), z.json())
const page = operationsPageSchema

function register(
  name: string,
  description: string,
  scopes: ("build:read" | "build:write" | "build:run")[],
  schema: z.ZodObject<z.ZodRawShape>,
  execute: (context: BuildContext, input: Record<string, unknown>) => unknown,
  options: {
    destructive?: boolean
    idempotent?: boolean
    openWorld?: boolean
    expectedRevision?: "none" | "optional" | "required"
    idempotency?: "none" | "optional" | "required"
    maxInputBytes?: number
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
  "build_list_agents",
  "List active managed customer-experience agents in the current project.",
  ["build:read"],
  z.object({ includeArchived: z.boolean().optional() }),
  (context, input) => listAgents(context, input as { includeArchived?: boolean })
)
register(
  "build_get_agent",
  "Read one managed agent and its current configuration.",
  ["build:read"],
  agentId.extend({ includeArchived: z.boolean().optional() }),
  (context, input) => getAgent(context, input.agentId as string, input as { includeArchived?: boolean })
)
register(
  "build_create_agent",
  "Create a managed customer-experience agent with an initial applied revision.",
  ["build:write"],
  z.object({
    id: id.optional(),
    slug: z.string().trim().max(120).optional(),
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).nullable().optional(),
    configuration: z.record(z.string().max(120), z.json()).optional(),
  }),
  (context, input) => createAgent(context, input as never),
  { idempotency: "optional" }
)
register(
  "build_update_agent",
  "Save an agent draft or apply it atomically using expectedRevision.",
  ["build:write"],
  agentId.extend({
    name: z.string().trim().min(1).max(160).optional(),
    slug: z.string().trim().max(120).optional(),
    description: z.string().max(2_000).nullable().optional(),
    configuration: z.record(z.string().max(120), z.json()).optional(),
    ...revision.shape,
    apply: z.boolean().optional(),
  }),
  (context, input) => updateAgent(context, input.agentId as string, input as never),
  { expectedRevision: "required", idempotency: "required" }
)
register(
  "build_clone_agent",
  "Clone an existing agent into a new managed agent.",
  ["build:write"],
  z.object({
    sourceAgentId: id,
    id: id.optional(),
    name: z.string().trim().min(1).max(160),
    slug: z.string().trim().max(120).optional(),
  }),
  (context, input) => cloneAgent(context, input.sourceAgentId as string, input as never),
  { idempotency: "optional" }
)
register(
  "build_archive_agent",
  "Archive an agent after checking its current revision.",
  ["build:write"],
  agentId.extend(revision.shape),
  (context, input) => archiveAgent(context, input.agentId as string, input.expectedRevision as number),
  { destructive: true, expectedRevision: "required", idempotency: "required" }
)
register(
  "build_list_agent_revisions",
  "List immutable revisions for an agent.",
  ["build:read"],
  agentId,
  (context, input) => listAgentRevisions(context, input.agentId as string)
)
register(
  "build_restore_agent_revision",
  "Restore an immutable agent revision as a new applied revision.",
  ["build:write"],
  agentId.extend({ sourceRevision: z.number().int().positive(), ...revision.shape }),
  (context, input) => restoreAgentRevision(context, input.agentId as string, input.sourceRevision as number, input.expectedRevision as number),
  { expectedRevision: "required", idempotency: "required" }
)

for (const [kind, list, get, save, listVersions, remove] of [
  ["action", listActions, getAction, saveAction, listActionRevisions, deleteAction],
  ["procedure", listProcedures, getProcedure, saveProcedure, listProcedureRevisions, deleteProcedure],
  ["widget", listWidgets, getWidget, saveWidget, listWidgetRevisions, deleteWidget],
] as const) {
  const resource = `${kind[0].toUpperCase()}${kind.slice(1)}`
  register(
    `build_list_${kind}s`,
    `List active ${kind} definitions for an agent.`,
    ["build:read"],
    agentId,
    (context, input) => list(context, input.agentId as string)
  )
  register(
    `build_get_${kind}`,
    `Read one ${kind} definition for an agent.`,
    ["build:read"],
    agentId.extend({ [`${kind}Id`]: id }),
    (context, input) => get(context, input.agentId as string, input[`${kind}Id`] as string)
  )
  register(
    `build_save_${kind}`,
    `Create or update a ${kind} definition with optimistic revision checks.`,
    ["build:write"],
    agentId.extend({ id: id.optional(), slug: z.string().trim().max(120).optional(), definition, expectedRevision: z.number().int().positive().optional() }),
    (context, input) => save(context, input.agentId as string, input as never),
    { expectedRevision: "optional", idempotency: "required" }
  )
  register(
    `build_list_${kind}_revisions`,
    `List immutable revisions for a ${kind}.`,
    ["build:read"],
    agentId.extend({ [`${kind}Id`]: id }),
    (context, input) => listVersions(context, input.agentId as string, input[`${kind}Id`] as string)
  )
  register(
    `build_delete_${kind}`,
    `Soft-delete a ${kind} definition using expectedRevision.`,
    ["build:write"],
    agentId.extend({ [`${kind}Id`]: id, ...revision.shape }),
    (context, input) => remove(context, input.agentId as string, input[`${kind}Id`] as string, input.expectedRevision as number),
    { destructive: true, expectedRevision: "required", idempotency: "required" }
  )
  void resource
}

register(
  "build_list_knowledge_sources",
  "List active knowledge sources and indexing status for an agent.",
  ["build:read"],
  agentId.extend(page.shape),
  (context, input) => listKnowledgeSources(context, input as never)
)
register(
  "build_get_knowledge_source",
  "Read a knowledge source, its text and structured Q&A pairs for editing. Does not return provider credentials.",
  ["build:read"],
  z.object({ sourceId: id }),
  (context, input) => getKnowledgeSource(context, input as never)
)
register(
  "build_list_knowledge_pages",
  "Browse indexed website or sitemap pages, with URL/title search and pagination.",
  ["build:read"],
  z.object({ sourceId: id, search: z.string().max(500).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
  (context, input) => listKnowledgePages(context, input as never)
)
register(
  "build_get_knowledge_page",
  "Read the stored Markdown or extracted text of one page from the active website index.",
  ["build:read"],
  z.object({ sourceId: id, url: z.string().min(1).max(8192), revision: z.number().int().nonnegative() }),
  (context, input) => getKnowledgePage(context, input as never)
)
register(
  "build_create_knowledge_source",
  "Create text, Q&A, file, website or sitemap knowledge and queue indexing. File contentBase64 is capped at 20 MiB decoded (the JSON schema exposes the encoded bound).",
  ["build:write"],
  z.object({ source: createKnowledgeSourceSchema }),
  (context, input) => createKnowledgeSource(context, input.source as never),
  { idempotency: "required", maxInputBytes: 32 * 1024 * 1024 }
)
register(
  "build_update_knowledge_source",
  "Update a knowledge source with optional expectedRevision and queue reindexing.",
  ["build:write"],
  z.object({ source: updateKnowledgeSourceSchema }),
  (context, input) => updateKnowledgeSource(context, input.source as never),
  { expectedRevision: "optional", idempotency: "required", maxInputBytes: 32 * 1024 * 1024 }
)
register(
  "build_delete_knowledge_source",
  "Delete a knowledge source and its active chunks.",
  ["build:write"],
  z.object({ sourceId: id }),
  (context, input) => deleteKnowledgeSource(context, input as never),
  { destructive: true, idempotency: "required" }
)
register(
  "build_preview_knowledge_source",
  "Preview extracted knowledge content before retrieval.",
  ["build:read"],
  z.object({ sourceId: id }),
  (context, input) => previewKnowledgeSource(context, input as never)
)
register(
  "build_export_knowledge_source",
  "Export a knowledge source as text or JSON.",
  ["build:read"],
  z.object({ sourceId: id, format: z.enum(["text", "json"]).optional() }),
  (context, input) => exportKnowledgeSource(context, input as never)
)
register(
  "build_enqueue_knowledge_index",
  "Queue indexing or resync for a knowledge source.",
  ["build:write"],
  z.object({ sourceId: id, kind: knowledgeJobKindSchema.optional() }),
  (context, input) => enqueueKnowledgeIndex(context, input as never),
  { idempotency: "required" }
)
register(
  "build_run_knowledge_job",
  "Claim and run one queued knowledge indexing job.",
  ["build:run"],
  z.object({ jobId: id }),
  (context, input) => runKnowledgeJob(context, input as never),
  { idempotency: "required", openWorld: true }
)
register(
  "build_run_queued_knowledge_jobs",
  "Run a bounded batch of queued knowledge jobs.",
  ["build:run"],
  z.object({ limit: z.number().int().min(1).max(100).optional() }),
  (context, input) => runQueuedKnowledgeJobs(context, input as never),
  { idempotency: "required", openWorld: true }
)
register(
  "build_retrieve_knowledge",
  "Retrieve active indexed chunks for an agent query.",
  ["build:run"],
  z.object({ agentId: id, query: z.string().trim().min(1).max(2_000), limit: z.number().int().min(1).max(20).optional() }),
  (context, input) => retrieveKnowledge(context, input as never)
)

register(
  "build_list_channels",
  "List configured delivery channels with credentials redacted.",
  ["build:read"],
  z.object({ agentId: id.optional() }),
  (context, input) => listChannelConnections(context, input.agentId as string | undefined)
)
register(
  "build_get_channel",
  "Read one configured delivery channel with credentials redacted.",
  ["build:read"],
  z.object({ connectionId: id }),
  (context, input) => getChannelConnection(context, input.connectionId as string)
)
register(
  "build_create_channel",
  "Create a channel connection. Submitted credentials are encrypted and never returned.",
  ["build:write"],
  z.object({
    id: id.optional(),
    agentId: id,
    channel: buildChannelSchema,
    label: z.string().trim().min(1).max(200),
    config: z.record(z.string().max(120), z.json()).optional(),
    credentials: z.record(z.string().max(120), z.json()).optional(),
    mode: z.enum(["webhook", "polling"]).optional(),
  }),
  (context, input) => createChannelConnection(context, input as never),
  { idempotency: "required" }
)
register(
  "build_update_channel",
  "Edit a channel name, allowed origins or Chat Bubble display and launcher settings without changing credentials or delivery state.",
  ["build:write"],
  z.object({ connectionId: id, label: z.string().trim().min(1).max(200).optional(), originAllowlist: z.array(z.string().url()).max(100).optional(), bubble: chatBubbleOverridesSchema.optional() }),
  (context, input) => updateChannelConnection(context, input as never),
  { idempotency: "required" }
)
register(
  "build_update_channel_status",
  "Pause, reconnect or mark a channel connection status.",
  ["build:write"],
  z.object({ connectionId: id, status: z.enum(["draft", "connected", "paused", "error", "disconnected"]), error: z.string().max(2_000).optional() }),
  (context, input) => updateChannelStatus(context, input.connectionId as string, input.status as never, input.error as string | undefined),
  { idempotency: "required" }
)
register(
  "build_register_telegram",
  "Validate a Telegram bot and register its webhook or polling mode.",
  ["build:run"],
  z.object({ connectionId: id, mode: z.enum(["webhook", "polling"]).optional(), dropPendingUpdates: z.boolean().optional() }),
  (context, input) => registerTelegramConnection(context, input.connectionId as string, input as never),
  { openWorld: true, idempotency: "required" }
)
register(
  "build_unregister_telegram",
  "Remove a Telegram webhook and disconnect the bot.",
  ["build:run"],
  z.object({ connectionId: id, dropPendingUpdates: z.boolean().optional() }),
  (context, input) => unregisterTelegramConnection(context, input.connectionId as string, input.dropPendingUpdates as boolean | undefined),
  { destructive: true, openWorld: true, idempotency: "required" }
)
register(
  "build_enqueue_telegram_polling",
  "Queue one bounded Telegram polling pass for connected polling bots.",
  ["build:run"],
  z.object({}),
  (context) => enqueueTelegramPollingJobs(context.database),
  { idempotent: true, idempotency: "optional" }
)
register(
  "build_enqueue_outbound_message",
  "Queue an outbound channel message with a stable idempotency key.",
  ["build:run"],
  z.object({
    envelope: z.object({
      connectionId: id,
      conversationId: id,
      channel: buildChannelSchema,
      idempotencyKey: id,
      text: z.string().max(100_000),
      attachments: z.array(z.json()).optional(),
      replyToProviderMessageId: z.string().max(500).optional(),
      metadata: z.record(z.string().max(120), z.json()).optional(),
    }),
    externalConversationId: z.string().max(500),
  }),
  (context, input) => enqueueOutboundEnvelope(context, input.envelope as never, input.externalConversationId as string),
  { openWorld: true, idempotency: "required" }
)

register(
  "build_create_contact",
  "Create or update a customer contact identity in the current project.",
  ["build:write"],
  contactInputSchema,
  (context, input) => createContact(context, input),
  { idempotency: "required" }
)
register(
  "build_get_contact",
  "Read one customer contact.",
  ["build:read"],
  z.object({ id }),
  (context, input) => getContact(context, input.id as string)
)
register(
  "build_update_contact",
  "Update a customer contact and preserve its channel identities.",
  ["build:write"],
  z.object({ id }).merge(contactInputSchema.partial()),
  (context, { id, ...changes }) => updateContact(context, id as string, changes),
  { idempotency: "required" },
)
register(
  "build_list_contacts",
  "List contacts with bounded pagination and optional status/search filters.",
  ["build:read"],
  page.extend({ status: z.enum(["active", "blocked", "archived"]).optional(), search: z.string().max(300).optional() }),
  (context, input) => listContacts(context, input)
)
register(
  "build_import_contacts",
  "Import bounded contact rows idempotently and return import outcomes.",
  ["build:write"],
  z.object({ source: z.string().trim().min(1).max(120), rows: z.array(contactInputSchema.extend({ externalId: z.string().trim().min(1).max(256) })).min(1).max(10_000) }),
  (context, input) => importContacts(context, input),
  { idempotency: "required" }
)
register(
  "build_export_contacts",
  "Request or read a bounded contact export.",
  ["build:read"],
  z.object({ format: z.enum(["csv", "json"]).optional(), filter: z.record(z.string().max(120), z.json()).optional(), limit: z.number().int().min(1).max(10_000).optional() }),
  (context, input) => exportContacts(context, input)
)
register(
  "build_request_contact_export",
  "Create a durable contact export job.",
  ["build:write"],
  z.object({ format: z.enum(["csv", "json"]).optional(), filter: z.record(z.string().max(120), z.json()).optional() }),
  (context, input) => requestContactExport(context, input),
  { idempotency: "required" }
)
register(
  "build_upsert_contact_identity",
  "Attach or update a channel identity for a contact.",
  ["build:write"],
  contactIdentityInputSchema,
  (context, input) => upsertContactIdentity(context, input),
  { idempotency: "required" }
)
register(
  "build_list_contact_identities",
  "List linked channel identities for a contact, including each external ID and its connection name and status when available.",
  ["build:read"],
  z.object({ contactId: id }),
  (context, input) => listContactIdentities(context, input.contactId as string)
)
register(
  "build_set_contact_attribute",
  "Set one collected contact attribute with source attribution.",
  ["build:write"],
  z.object({ contactId: id, key: z.string().trim().min(1).max(120), value: z.json(), source: z.string().trim().min(1).max(120) }),
  (context, input) => setContactAttribute(context, input as never),
  { idempotency: "required" }
)
register(
  "build_list_contact_attributes",
  "List collected attributes for a contact.",
  ["build:read"],
  z.object({ contactId: id }),
  (context, input) => listContactAttributes(context, input.contactId as string)
)
register(
  "build_collect_data",
  "Persist a collected customer field linked to a conversation or contact.",
  ["build:write"],
  z.object({ contactId: id.optional(), conversationId: id.optional(), fieldKey: z.string().trim().min(1).max(120), value: z.json(), source: z.string().trim().min(1).max(120) }),
  (context, input) => collectData(context, input),
  { idempotency: "required" }
)
register(
  "build_list_collected_data",
  "List collected fields using bounded pagination.",
  ["build:read"],
  page.extend({ contactId: id.optional(), conversationId: id.optional(), fieldKey: z.string().max(120).optional() }),
  (context, input) => listCollectedData(context, input)
)
register(
  "build_upsert_lead",
  "Create or update a lead linked to a contact or conversation.",
  ["build:write"],
  z.object({ id: id.optional(), contactId: id.optional(), conversationId: id.optional(), status: z.string().trim().min(1).max(80).default("new"), score: z.number().int().min(0).max(100).nullable().optional(), source: z.string().max(120).nullable().optional(), data: z.record(z.string().max(120), z.json()).default({}) }),
  (context, input) => upsertLead(context, input),
  { idempotency: "required" }
)
register(
  "build_list_leads",
  "List leads using bounded pagination and optional filters.",
  ["build:read"],
  page.extend({ status: z.string().max(80).optional(), contactId: id.optional() }),
  (context, input) => listLeads(context, input)
)

register(
  "build_create_ticket",
  "Create or reuse an inbox ticket for an authoritative Build conversation.",
  ["build:write"],
  z.object({ conversationId: id, contactId: id.optional(), channel: buildChannelSchema.default("telegram"), subject: z.string().max(500).optional(), status: z.enum(["open", "pending", "snoozed", "solved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(50).optional() }),
  (context, input) => createTicket(context, input),
  { idempotency: "required" }
)
register("build_get_ticket", "Read one inbox ticket.", ["build:read"], z.object({ id }), (context, input) => getTicket(context, input.id as string))
register(
  "build_list_tickets",
  "Search the inbox queue by subject or customer, with bounded status, priority, team, assignee and channel filters.",
  ["build:read"],
  page.extend({ search: z.string().max(300).optional(), status: z.enum(["open", "pending", "snoozed", "solved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), teamId: id.optional(), assigneeUserId: id.optional(), channel: buildChannelSchema.optional() }),
  (context, input) => listTickets(context, input)
)
register(
  "build_update_ticket",
  "Update inbox state with optional optimistic version protection.",
  ["build:write"],
  z.object({ id, status: z.enum(["open", "pending", "snoozed", "solved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), subject: z.string().max(500).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(), snoozeUntil: z.string().datetime().nullable().optional(), expectedVersion: z.number().int().positive().optional() }),
  (context, { id, ...changes }) => updateTicket(context, id as string, changes)
)
register("build_add_ticket_note", "Add an internal note to a ticket.", ["build:write"], z.object({ ticketId: id, body: z.string().trim().min(1).max(16_000) }), (context, input) => addTicketNote(context, input))
register("build_list_ticket_notes", "List internal ticket notes.", ["build:read"], z.object({ ticketId: id }), (context, input) => listTicketNotes(context, input.ticketId as string))
register(
  "build_assign_ticket",
  "Assign ticket ownership with mandatory expectedVersion conflict protection.",
  ["build:write"],
  z.object({ ticketId: id, assigneeUserId: id.nullable().optional(), teamId: id.nullable().optional(), expectedVersion: z.number().int().positive() }),
  (context, input) => assignTicket(context, input)
)
register(
  "build_takeover_conversation",
  "Acquire a human conversation lease and reject a live lease held by another agent.",
  ["build:write"],
  z.object({ conversationId: id, teamId: id.nullable().optional(), leaseSeconds: z.number().int().min(30).max(86_400).optional(), expectedVersion: z.number().int().positive().optional() }),
  (context, input) => takeoverConversation(context, input)
)
register(
  "build_resume_conversation",
  "Release the actor's human lease and return conversation ownership to AI.",
  ["build:write"],
  z.object({ conversationId: id, expectedVersion: z.number().int().positive(), leaseToken: z.string().max(256).optional() }),
  (context, input) => resumeConversation(context, input)
)
register("build_get_conversation_ownership", "Read AI/human ownership and lease state.", ["build:read"], z.object({ conversationId: id }), (context, input) => getConversationOwnership(context, input.conversationId as string))
register("build_send_human_reply", "Send a human reply and automatically assign the ticket to the authenticated sender. Requires an active human lease and organization membership.", ["build:run"], z.object({ conversationId: id, connectionId: id.optional(), externalConversationId: z.string().trim().min(1).max(500).optional(), text: z.string().trim().min(1).max(100_000), attachments: z.array(z.record(z.string().max(120), z.json())).max(20).optional(), clientMessageId: z.string().trim().min(1).max(200).optional() }), (context, input) => sendHumanReply(context, input), { idempotency: "required", openWorld: true })
register("build_list_ticket_events", "Read the immutable ticket event timeline.", ["build:read"], z.object({ ticketId: id }), (context, input) => listTicketEvents(context, input.ticketId as string))
register("build_request_csat", "Issue a pending CSAT survey for a ticket or conversation.", ["build:write"], z.object({ ticketId: id.optional(), conversationId: id.optional(), contactId: id.optional(), channel: buildChannelSchema.optional(), expiresAt: z.string().datetime().optional() }), (context, input) => requestCsat(context, input))
register("build_submit_csat", "Record a one-to-five CSAT rating and comment.", ["build:write"], z.object({ surveyId: id, rating: z.number().int().min(1).max(5), comment: z.string().max(4_000).optional() }), (context, input) => submitCsat(context, input))
register("build_list_csat", "List CSAT survey requests and responses.", ["build:read"], page.extend({ status: z.enum(["pending", "answered", "expired", "cancelled"]).optional() }), (context, input) => listCsat(context, input))

register("build_create_team", "Create an organization-wide team with optional members.", ["build:write"], teamInputSchema, (context, input) => createTeam(context, input), { idempotency: "required" })
register("build_update_team", "Update an organization-wide team and optionally replace its members.", ["build:write"], teamInputSchema.partial().extend({ id }), (context, { id: teamId, ...input }) => updateTeam(context, teamId as string, input))
register("build_list_teams", "List the active organization's teams and member IDs.", ["build:read"], z.object({}), (context) => listTeams(context))
register("build_list_organization_members", "List organization members with names and avatars for assignment.", ["build:read"], z.object({}), (context) => listOrganizationMembers(context))
register("build_set_team_member", "Add or update team membership, availability and capacity.", ["build:write"], z.object({ teamId: id, userId: id, role: z.enum(["agent", "lead", "manager"]).optional(), availability: z.enum(["online", "away", "offline"]).optional(), maxConcurrent: z.number().int().min(1).max(1000).optional() }), (context, input) => setTeamMember(context, input))
register("build_set_agent_availability", "Set availability for all organization team memberships of a user.", ["build:write"], z.object({ userId: id, availability: z.enum(["online", "away", "offline"]) }), (context, input) => setAgentAvailability(context, input))
register("build_create_routing_rule", "Create a priority-ordered inbox routing rule.", ["build:write"], z.object({ name: z.string().trim().min(1).max(160), priority: z.number().int().min(0).max(1000).optional(), enabled: z.boolean().optional(), conditions: z.record(z.string().max(120), z.json()).optional(), teamId: id.nullable().optional(), assigneeUserId: id.nullable().optional() }), (context, input) => createRoutingRule(context, input), { idempotency: "required" })
register("build_list_routing_rules", "List inbox routing rules.", ["build:read"], z.object({}), (context) => listRoutingRules(context))
register("build_resolve_routing", "Resolve the first matching rule for a ticket context.", ["build:read"], z.object({ channel: z.string().max(80).optional(), priority: z.string().max(40).optional(), tags: z.array(z.string().max(80)).optional(), contactStatus: z.string().max(40).optional() }), (context, input) => resolveRouting(context, input))
register("build_create_macro", "Create an inbox response macro.", ["build:write"], z.object({ name: z.string().trim().min(1).max(160), body: z.string().min(1).max(16_000), actions: z.array(macroActionSchema).optional(), enabled: z.boolean().optional() }), (context, input) => createMacro(context, input), { idempotency: "required" })
register("build_update_macro", "Update an inbox response macro.", ["build:write"], z.object({ id, name: z.string().trim().min(1).max(160).optional(), body: z.string().min(1).max(16_000).optional(), actions: z.array(macroActionSchema).optional(), enabled: z.boolean().optional() }), (context, input) => updateMacro(context, input.id as string, input))
register("build_list_macros", "List inbox response macros.", ["build:read"], z.object({}), (context) => listMacros(context))
register("build_apply_macro", "Apply bounded ticket-state actions from an enabled inbox macro.", ["build:write"], z.object({ macroId: id, ticketId: id, expectedVersion: z.number().int().positive() }), (context, input) => applyMacro(context, input))

register("build_create_campaign", "Create a Telegram-first channel-aware campaign.", ["build:write"], z.object({ name: z.string().trim().min(1).max(200), channel: buildChannelSchema.default("telegram"), connectionId: id.optional(), template: z.record(z.string().max(120), z.json()).optional(), audienceFilter: z.record(z.string().max(120), z.json()).optional(), suppressionFilter: z.record(z.string().max(120), z.json()).optional(), scheduledAt: z.string().datetime().nullable().optional() }), (context, input) => createCampaign(context, input), { idempotency: "required" })
register("build_get_campaign", "Read campaign configuration and audience filters.", ["build:read"], z.object({ id }), (context, input) => getCampaign(context, input.id as string))
register("build_list_campaigns", "List campaigns with audience and delivery status metrics.", ["build:read"], page.extend({ status: z.enum(["draft", "scheduled", "running", "paused", "completed", "failed"]).optional(), search: z.string().max(300).optional() }), (context, input) => listCampaigns(context, input))
register("build_update_campaign", "Update campaign configuration before delivery.", ["build:write"], z.object({ id, name: z.string().trim().min(1).max(200).optional(), channel: buildChannelSchema.optional(), connectionId: id.optional(), template: z.record(z.string().max(120), z.json()).optional(), audienceFilter: z.record(z.string().max(120), z.json()).optional(), suppressionFilter: z.record(z.string().max(120), z.json()).optional(), scheduledAt: z.string().datetime().nullable().optional() }), (context, input) => updateCampaign(context, input.id as string, input))
register("build_set_campaign_status", "Transition campaign state through draft, scheduled, running, paused, completed or failed.", ["build:write"], z.object({ campaignId: id, status: z.enum(["draft", "scheduled", "running", "paused", "completed", "failed"]) }), (context, input) => setCampaignStatus(context, input))
register("build_run_campaign", "Snapshot the audience and queue a campaign for the channel worker.", ["build:run"], z.object({ id }), (context, input) => runCampaign(context, { campaignId: input.id }), { idempotency: "required" })
register("build_snapshot_campaign_audience", "Freeze eligible and suppressed contacts for a campaign.", ["build:write"], z.object({ campaignId: id }), (context, input) => snapshotCampaignAudience(context, input.campaignId as string))
register("build_suppress_campaign_contact", "Add contact suppression and stop eligible or queued deliveries.", ["build:write"], z.object({ contactId: id, reason: z.string().trim().min(1).max(200), expiresAt: z.string().datetime().nullable().optional() }), (context, input) => suppressCampaignContact(context, input))
register("build_queue_campaign_deliveries", "Create idempotent Telegram delivery jobs from a frozen audience.", ["build:run"], z.object({ campaignId: id }), (context, input) => queueCampaignDeliveries(context, input.campaignId as string), { idempotency: "required" })
register("build_claim_campaign_deliveries", "Atomically claim queued deliveries for a channel worker.", ["build:run"], z.object({ limit: z.number().int().min(1).max(100).optional() }), (context, input) => claimCampaignDeliveries(context, input), { idempotency: "required" })
register("build_process_next_campaign_delivery", "Claim one campaign recipient and admit it to the Telegram channel outbox; provider delivery is reconciled by the channel worker.", ["build:run"], z.object({ limit: z.literal(1).optional(), connectionId: id.optional() }), (context, input) => processNextCampaignDelivery(context, input), { idempotency: "required", openWorld: true })
register("build_acknowledge_campaign_delivery", "Record provider delivery state and update audience metrics.", ["build:run"], z.object({ deliveryId: id, state: z.enum(["sent", "delivered", "read", "replied", "failed"]), providerMessageId: z.string().max(512).optional(), error: z.string().max(4_000).optional(), retryAt: z.string().datetime().optional() }), (context, input) => acknowledgeCampaignDelivery(context, input), { idempotency: "required" })
register("build_list_campaign_deliveries", "List bounded campaign delivery receipts and failures.", ["build:read"], page.extend({ campaignId: id.optional(), state: z.enum(["queued", "sending", "sent", "delivered", "read", "replied", "failed", "suppressed"]).optional() }), (context, input) => listCampaignDeliveries(context, input))

register("build_get_health", "Read bounded Build worker backlog, oldest jobs, failures and uncertain delivery counts for the current project.", ["build:read"], z.object({}), (context) => getBuildHealth(context))
register("build_list_delivery_failures", "List bounded, sanitized failed or uncertain channel job metadata without exposing payloads or provider responses.", ["build:read"], page.extend({ status: z.enum(["failed", "uncertain", "all"]).optional() }), (context, input) => listDeliveryFailures(context, input))
register("build_retry_delivery", "Explicitly requeue one known pre-send channel failure; uncertain outcomes are never retried.", ["build:run"], z.object({ jobId: z.string().uuid(), expectedCode: z.enum(safeDeliveryRetryCodes) }), (context, input) => retryDelivery(context, input), { idempotency: "required" })

register("build_record_operation_event", "Record a runtime, channel or customer-operation event used by analytics.", ["build:run"], z.object({ eventType: z.enum(["message_received", "message_sent", "agent_failed", "tool_failed", "low_feedback", "handoff", "ticket_created", "ticket_resolved", "csat_submitted", "campaign_sent", "campaign_delivered", "campaign_replied"]), conversationId: id.optional(), contactId: id.optional(), channel: buildChannelSchema.optional(), payload: z.record(z.string().max(200), z.json()).optional(), occurredAt: z.string().datetime().optional() }), (context, input) => recordOperationEvent(context, input), { idempotency: "optional" })
register("build_record_feedback", "Record customer feedback on a response and its trace, retaining evidence for knowledge-gap discovery.", ["build:run"], z.object({ conversationId: id.optional(), messageId: id.optional(), contactId: id.optional(), channel: buildChannelSchema.optional(), question: z.string().trim().min(1).max(4_000), sentiment: z.enum(["positive", "negative", "unknown"]).optional(), reason: z.string().max(500).optional(), metadata: z.record(z.string(), z.json()).optional() }), (context, input) => recordFeedback(context, input))
register("build_get_operational_analytics", "Read actual event, ticket, conversation, channel and CSAT aggregates for a bounded period.", ["build:read"], z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }), (context, input) => getOperationalAnalytics(context, input))
register("build_refresh_knowledge_gap_suggestions", "Derive knowledge gaps from runtime failures and negative feedback.", ["build:run"], z.object({ limit: z.number().int().min(1).max(100).optional() }), (context, input) => refreshKnowledgeGapSuggestions(context, input))
register("build_list_knowledge_gap_suggestions", "List evidence-backed knowledge-gap suggestions.", ["build:read"], page.extend({ status: z.enum(["open", "ignored", "resolved"]).optional() }), (context, input) => listKnowledgeGapSuggestions(context, input))
register("build_update_knowledge_gap_status", "Mark a knowledge-gap suggestion open, ignored or resolved.", ["build:write"], z.object({ id, status: z.enum(["open", "ignored", "resolved"]) }), (context, input) => updateKnowledgeGapStatus(context, input))

register(
  "build_list_simulations",
  "List active customer simulations for a managed Build agent.",
  ["build:read"],
  agentId.extend({ includeArchived: z.boolean().optional() }),
  (context, input) => listSimulationDefinitions(context, input.agentId as string, Boolean(input.includeArchived)),
)
register(
  "build_get_simulation",
  "Read one immutable-revision customer simulation definition.",
  ["build:read"],
  agentId.extend({ definitionId: id, includeArchived: z.boolean().optional() }),
  (context, input) => getSimulationDefinition(context, input.agentId as string, input.definitionId as string, Boolean(input.includeArchived)),
)
register(
  "build_create_simulation",
  "Persist a customer persona/scenario simulation definition without executing it.",
  ["build:write"],
  agentId.extend({ id: id.optional(), definition: simulationDefinitionSchema }),
  (context, input) => createSimulationDefinition(context, { agentId: input.agentId as string, id: input.id as string | undefined, definition: input.definition }),
  { idempotency: "optional" },
)
register(
  "build_update_simulation",
  "Replace a simulation definition using optimistic revision protection; historical runs retain their snapshots.",
  ["build:write"],
  agentId.extend({
    definitionId: id,
    definition: simulationDefinitionSchema,
    ...revision.shape,
  }),
  (context, input) => updateSimulationDefinition(context, input.agentId as string, input.definitionId as string, { definition: input.definition, expectedRevision: input.expectedRevision as number }),
  { destructive: true, expectedRevision: "required", idempotency: "required" },
)
register(
  "build_archive_simulation",
  "Archive a simulation definition while preserving historical runs and transcripts.",
  ["build:write"],
  agentId.extend({ definitionId: id, ...revision.shape }),
  (context, input) => archiveSimulationDefinition(context, input.agentId as string, input.definitionId as string, input.expectedRevision as number),
  { destructive: true, expectedRevision: "required", idempotency: "required" },
)
register(
  "build_list_simulation_revisions",
  "List immutable simulation definition revisions.",
  ["build:read"],
  agentId.extend({ definitionId: id }),
  (context, input) => listSimulationDefinitionRevisions(context, input.agentId as string, input.definitionId as string),
)
register(
  "build_add_simulation_tool_mock",
  "Add a deterministic action response/error mock; simulation workers never call live action endpoints.",
  ["build:write"],
  agentId.extend({ definitionId: id, mock: toolMockSchema }),
  (context, input) => addSimulationToolMock(context, input.agentId as string, input.definitionId as string, input.mock),
  { idempotency: "optional" },
)
register(
  "build_list_simulation_tool_mocks",
  "List tool mocks attached to a simulation definition.",
  ["build:read"],
  agentId.extend({ definitionId: id }),
  (context, input) => listSimulationToolMocks(context, input.agentId as string, input.definitionId as string),
)
register(
  "build_start_simulation",
  "Queue a simulation run against an immutable agent/configuration/source/action snapshot and expand model/repeat cases.",
  ["build:run"],
  agentId.extend({ definitionId: id, models: z.array(id).min(1).max(20).optional(), repeats: z.number().int().min(1).max(100).optional() }),
  (context, input) => startSimulationRun(context, input.agentId as string, input.definitionId as string, {
    models: input.models as string[] | undefined,
    repeats: input.repeats as number | undefined,
    requestedBy: context.actorId ?? null,
  }),
  { destructive: true, idempotency: "required", openWorld: true },
)
register(
  "build_list_simulation_runs",
  "List simulation summaries with passed, failed, no-verdict and infrastructure-error counts.",
  ["build:read"],
  z.object({ definitionId: id.optional() }),
  (context, input) => listSimulationRuns(context, input.definitionId as string | undefined),
)
register(
  "build_get_simulation_run",
  "Read one simulation run and its frozen configuration snapshot metadata.",
  ["build:read"],
  z.object({ runId: id }),
  (context, input) => getSimulationRun(context, input.runId as string),
)
register(
  "build_list_simulation_cases",
  "Read case transcripts, observed actions and distinct verdict classes for a run.",
  ["build:read"],
  z.object({ runId: id }),
  (context, input) => listSimulationCases(context, input.runId as string),
)
register(
  "build_cancel_simulation",
  "Cancel a queued or running simulation and fence unfinished cases.",
  ["build:run"],
  z.object({ runId: id }),
  (context, input) => cancelSimulationRun(context, input.runId as string),
  { destructive: true, idempotency: "required" },
)
register(
  "build_recover_simulation",
  "Recover an expired simulation lease without rerunning completed cases.",
  ["build:run"],
  z.object({ runId: id }),
  (context, input) => recoverSimulationRun(context, input.runId as string),
  { destructive: true, idempotency: "required" },
)
register(
  "build_create_copilot_proposal",
  "Generate a reviewable management-copilot proposal for instructions, a procedure, a widget or an action. The current target is redacted and no mutation occurs.",
  ["build:write"],
  copilotProposalInputSchema,
  (context, input) => createCopilotProposal(context, input, { generator: defaultCopilotGenerator(context) }),
  { idempotency: "optional", openWorld: true },
)
register(
  "build_list_copilot_proposals",
  "List management-copilot proposals for an agent.",
  ["build:read"],
  agentId.extend({ status: z.enum(["proposed", "approved", "rejected", "applied", "expired"]).optional() }),
  (context, input) => listCopilotProposals(context, input.agentId as string, input.status as never),
)
register(
  "build_get_copilot_proposal",
  "Read a copilot proposal, source snapshot, proposed value and redacted diff.",
  ["build:read"],
  z.object({ proposalId: id }),
  (context, input) => getCopilotProposal(context, input.proposalId as string),
)
register(
  "build_approve_copilot_proposal",
  "Approve a copilot proposal for explicit later application.",
  ["build:write"],
  z.object({ proposalId: id }),
  (context, input) => approveCopilotProposal(context, input.proposalId as string),
  { destructive: true, idempotency: "required" },
)
register(
  "build_reject_copilot_proposal",
  "Reject a copilot proposal without changing the agent.",
  ["build:write"],
  z.object({ proposalId: id }),
  (context, input) => rejectCopilotProposal(context, input.proposalId as string),
  { destructive: true, idempotency: "required" },
)
register(
  "build_apply_copilot_proposal",
  "Apply an approved copilot proposal only when its optimistic source revision still matches; stale proposals expire.",
  ["build:write"],
  z.object({ proposalId: id, ...revision.shape }),
  (context, input) => applyCopilotProposal(context, input.proposalId as string, input.expectedRevision as number),
  { destructive: true, expectedRevision: "required", idempotency: "required" },
)
register(
  "build_list_copilot_audit",
  "List immutable audit events for a management-copilot proposal.",
  ["build:read"],
  z.object({ proposalId: id }),
  (context, input) => listCopilotAudit(context, input.proposalId as string),
)


// WhatsApp uses the same authenticated registry for browser, CLI and MCP.
register("build_get_whatsapp_setup", "Read WhatsApp installation readiness and public Embedded Signup settings. Never returns secrets.", ["build:read"], z.object({}), () => getWhatsAppSetup())
register("build_get_whatsapp_connection", "Read the connected business number, coexistence mode, authorization expiry and import status.", ["build:read"], z.object({ connectionId: z.string().uuid() }), (context, input) => getWhatsAppConnection(context, input.connectionId as string))
register("build_begin_whatsapp_signup", "Start a short-lived Embedded Signup session. Open connectUrl to authorize the business in Meta; tokens stay server-side.", ["build:write"], z.object({ connectionId: z.string().uuid(), mode: whatsappModeSchema }), (context, input) => beginWhatsAppSignup(context, input as never), { idempotency: "required" })
register("build_get_whatsapp_signup", "Read the status and authorized phone choices for a project-scoped Embedded Signup session.", ["build:read"], z.object({ sessionId: z.string().uuid() }), (context, input) => getWhatsAppSignup(context, input.sessionId as string))
register("build_authorize_whatsapp_signup", "Exchange a one-use Meta authorization code and verify the app, permissions and business account. Never returns tokens.", ["build:write", "build:run"], z.object({ sessionId: z.string().uuid(), code: z.string().min(1).max(8192), wabaId: metaIdSchema.optional() }), (context, input) => authorizeWhatsAppSignup(context, input as never), { openWorld: true, idempotency: "required" })
register("build_activate_whatsapp_signup", "Connect an authorized number and subscribe to webhooks. Coexistence preserves the Business App registration; cloud mode registers the number.", ["build:write", "build:run"], z.object({ sessionId: z.string().uuid(), phoneNumberId: metaIdSchema, pin: z.string().regex(/^\d{6}$/).optional() }), (context, input) => activateWhatsAppSignup(context, input as never), { openWorld: true, idempotency: "required" })
register("build_refresh_whatsapp_connection", "Check that Meta authorization still works and read phone quality.", ["build:read"], z.object({ connectionId: z.string().uuid() }), (context, input) => refreshWhatsAppConnection(context, input.connectionId as string), { openWorld: true })
register("build_disconnect_whatsapp", "Stop this channel, remove locally stored credentials and cancel queued jobs. Does not deregister the phone or disrupt the Business App.", ["build:write"], z.object({ connectionId: z.string().uuid() }), (context, input) => disconnectWhatsApp(context, input.connectionId as string), { destructive: true, idempotency: "required" })
register("build_list_whatsapp_templates", "List Meta message templates and approval status with bounded pagination.", ["build:read"], z.object({ connectionId: z.string().uuid(), after: z.string().max(2048).optional() }), (context, input) => listWhatsAppTemplates(context, input as never), { openWorld: true })
register("build_create_whatsapp_template", "Submit a message template to Meta for approval.", ["build:write", "build:run"], z.object({ connectionId: z.string().uuid(), name: whatsappTemplateSchema.shape.name, language: whatsappTemplateSchema.shape.language.shape.code, category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]), components: z.array(z.record(z.string(), z.json())).min(1).max(20) }), (context, input) => createWhatsAppTemplate(context, input as never), { openWorld: true, idempotency: "required" })
register("build_delete_whatsapp_template", "Delete a named template from the connected WhatsApp business account.", ["build:write", "build:run"], z.object({ connectionId: z.string().uuid(), name: whatsappTemplateSchema.shape.name }), (context, input) => deleteWhatsAppTemplate(context, input as never), { destructive: true, openWorld: true, idempotency: "required" })
register("build_get_whatsapp_recipient", "Read a recipient's 24-hour reply window and outbound consent for one channel.", ["build:read"], z.object({ connectionId: z.string().uuid(), recipient: whatsappRecipientSchema }), (context, input) => getWhatsAppRecipient(context, input as never))
register("build_set_whatsapp_consent", "Record documented permission or an opt-out. Never invent permission; include the source and date in note.", ["build:write"], z.object({ connectionId: z.string().uuid(), recipient: whatsappRecipientSchema, optedOut: z.boolean(), templateOptIn: z.boolean(), note: z.string().trim().min(1).max(1000) }), (context, input) => setWhatsAppConsent(context, input as never), { idempotency: "required" })
register("build_send_whatsapp_template", "Queue an approved Meta template for a conversation. The worker enforces opt-in and block status before sending.", ["build:run"], z.object({ connectionId: z.string().uuid(), conversationId: id, template: whatsappTemplateSchema }), (context, input) => sendWhatsAppTemplate(context, { ...input, idempotencyKey: context.idempotencyKey } as never), { openWorld: true, idempotency: "required" })
register("build_sync_whatsapp_app", "Request a one-time, consented Business App contact or history import during Meta's onboarding window. Imported messages never trigger the agent.", ["build:write", "build:run"], z.object({ connectionId: z.string().uuid(), type: z.enum(["history", "smb_app_state_sync"]), consent: z.literal(true) }), (context, input) => syncWhatsAppApp(context, input as never), { openWorld: true, idempotency: "required" })

register("build_get_whatsapp_delivery", "Read provider delivery/read receipts and queue state for a project-owned outbound WhatsApp message.", ["build:read"], z.object({ connectionId: z.string().uuid(), messageId: id }), (context, input) => getWhatsAppDelivery(context, input as never))
register("build_get_whatsapp_media", "Download an attachment received on this channel as base64, up to 5 MiB. Never returns a Meta access token or media URL.", ["build:read"], z.object({ connectionId: z.string().uuid(), mediaId: metaIdSchema }), (context, input) => getWhatsAppMedia(context, input as never), { openWorld: true })

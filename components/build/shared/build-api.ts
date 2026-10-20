import { callBuild } from "@/src/lib/build/client"

/**
 * Build uses the same project-bound operation catalog as MCP. Keeping the
 * browser client this small makes every form exercise the exact operation
 * contract exposed to MCP and the CLI rather than growing page-only routes.
 */
export const buildOperations = {
  listAgents: "build_list_agents",
  getAgent: "build_get_agent",
  createAgent: "build_create_agent",
  updateAgent: "build_update_agent",
  cloneAgent: "build_clone_agent",
  archiveAgent: "build_archive_agent",
  listAgentRevisions: "build_list_agent_revisions",
  applyAgentRevision: "build_restore_agent_revision",
  createCopilotProposal: "build_create_copilot_proposal",
  listCopilotProposals: "build_list_copilot_proposals",
  getCopilotProposal: "build_get_copilot_proposal",
  approveCopilotProposal: "build_approve_copilot_proposal",
  rejectCopilotProposal: "build_reject_copilot_proposal",
  applyCopilotProposal: "build_apply_copilot_proposal",
  listCopilotAudit: "build_list_copilot_audit",
  listKnowledge: "build_list_knowledge_sources",
  getKnowledge: "build_get_knowledge_source",
  listKnowledgePages: "build_list_knowledge_pages",
  getKnowledgePage: "build_get_knowledge_page",
  createKnowledge: "build_create_knowledge_source",
  updateKnowledge: "build_update_knowledge_source",
  deleteKnowledge: "build_delete_knowledge_source",
  indexKnowledge: "build_enqueue_knowledge_index",
  listActions: "build_list_actions",
  getAction: "build_get_action",
  createAction: "build_save_action",
  updateAction: "build_save_action",
  deleteAction: "build_delete_action",
  listProcedures: "build_list_procedures",
  getProcedure: "build_get_procedure",
  createProcedure: "build_save_procedure",
  updateProcedure: "build_save_procedure",
  deleteProcedure: "build_delete_procedure",
  listWidgets: "build_list_widgets",
  getWidget: "build_get_widget",
  createWidget: "build_save_widget",
  updateWidget: "build_save_widget",
  deleteWidget: "build_delete_widget",
  listChannels: "build_list_channels",
  connectChannel: "build_create_channel",
  updateChannel: "build_update_channel_status",
  disconnectChannel: "build_update_channel_status",
  testChannel: "build_register_telegram",
  createConversation: "build_create_conversation",
  listConversationMessages: "build_list_conversation_messages",
  listConversationTools: "build_list_conversation_tools",
  runTurn: "build_run_agent_turn",
} as const

export type BuildOperation =
  (typeof buildOperations)[keyof typeof buildOperations]

/** Call a project-bound agent operation from a client component. */
export async function buildCall<T>(
  operation: BuildOperation | string,
  input: unknown = {},
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : input
  const key =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `build-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const requestKey =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).requestKey
      : undefined
  return callBuild<T>(operation, value as Record<string, unknown>, {
    signal: options.signal,
    idempotencyKey: key,
    requestKey: typeof requestKey === "string" ? requestKey : undefined,
  })
}

export function listItems<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.items)) return record.items as T[]
    if (Array.isArray(record.sources)) return record.sources as T[]
    if (Array.isArray(record.actions)) return record.actions as T[]
    if (Array.isArray(record.procedures)) return record.procedures as T[]
    if (Array.isArray(record.widgets)) return record.widgets as T[]
    if (Array.isArray(record.channels)) return record.channels as T[]
    if (Array.isArray(record.agents)) return record.agents as T[]
  }
  return []
}

export function formatBuildError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Build operation failed. Try again."
}

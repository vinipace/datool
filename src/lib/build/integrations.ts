export type AppConnection = {
  id: string
  toolkit: string
  label: string
  status: "pending" | "active" | "disconnected" | "failed"
}
export type IntegrationCatalog = {
  configured: boolean
  apps: { slug: string; name: string }[]
  connections: AppConnection[]
}
export type IntegrationTool = {
  slug: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export type AgentUsageRow = AgentUsageMetrics & {
  projectId: string
  projectName: string
  agentId: string
  agentName: string
  conversationId: string | null
}
export type AgentUsageMetrics = {
  modelCalls: number
  integrationCalls: number
  failedCalls: number
  pendingCalls: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  missingTokenCalls: number
  modelCostUsd: number
  integrationCostUsd: number
  unpricedModelCalls: number
}
export type AgentUsage = {
  periodStart: string
  periodEnd: string
  totals: AgentUsageMetrics
  agents: AgentUsageRow[]
  conversations: AgentUsageRow[]
  rowLimit: number
}

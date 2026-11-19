import { z } from "zod"
import type { AppDefinition } from "@/src/lib/playground/contracts"
import {
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { getTracerProjectId, type TracerDatabase } from "../tracer/db"
import { getAgent } from "./agents"
import { agentEvaluationInputSchema } from "@/src/lib/build/agent-journey"
import { captureEvaluationCatalog, evaluationFingerprint } from "./testing/evaluation-catalog"
import type { AppliedAgentDefinitions } from "./definitions"

export const agentEvaluationPrefix = "build-agent."
export type AgentEvaluationTarget = { database: TracerDatabase; agent: ManagedAgent; catalog: AppliedAgentDefinitions; fingerprint: string }

/** The existing eval executor pins this definition and checks it before dispatch. */
export async function resolveAgentEvaluation(
  database: TracerDatabase,
  id: string,
) {
  const projectId = getTracerProjectId(database)
  const agent = await getAgent({ database, projectId }, id)
  const catalog = await captureEvaluationCatalog({ database, projectId }, agent)
  const fingerprint = evaluationFingerprint(agent.configuration, catalog)
  const definition: AppDefinition = {
    id: `${agentEvaluationPrefix}${id}`,
    name: agent.name,
    mode: "input",
    revision: agent.currentRevision,
    inputSchema: z.toJSONSchema(agentEvaluationInputSchema, { target: "draft-7", io: "input", unrepresentable: "any" }),
    outputSchema: { type: "string" },
    evaluatorIds: [],
    internalTracing: true,
    codeProvenance: {
      source: "declared",
      fingerprint,
    },
  }
  return { definition, buildAgent: { database, agent: { ...agent, appliedRevision: agent.currentRevision, appliedConfiguration: agent.configuration }, catalog, fingerprint } }
}

/** Each frozen case gets its own conversation and the real knowledge/model path. */
export async function executeAgentEvaluation(
  target: AgentEvaluationTarget,
  input: unknown,
  callId: string,
  scope?: PromptRunScope,
  execution?: { assertActive: () => Promise<void> },
) {
  const parsed = agentEvaluationInputSchema.parse(input)
  if (typeof parsed !== "string" && parsed.journey) {
    const { executeJourneyEvaluation } = await import("./testing/journey-executor")
    return executeJourneyEvaluation(target, parsed.message, parsed.journey, callId, scope, execution)
  }
  const message = typeof parsed === "string" ? parsed : parsed.message
  const channel = typeof parsed === "string" ? "web" : parsed.channel
  const { runAgentTurn } = await import("./runtime")
  const result = await runAgentTurn(
    { database: target.database, projectId: target.agent.projectId },
    {
      agentId: target.agent.id,
      channel,
      externalConversationId: `eval:${callId}`,
      requestKey: `eval:${callId}`,
      message,
      metadata: { evalRunId: scope?.runId ?? null, evaluation: true },
    },
    {
      agent: target.agent,
      catalog: target.catalog,
      recordFormData: false,
      signal: AbortSignal.timeout(60_000),
      dependencies: {
        mockExternalActions: true,
        executeAction: async () => ({
          status: "failed",
          output: {
            error: "External actions are disabled during dataset evaluations.",
          },
        }),
      },
    },
  )
  if (!["completed", "blocked", "replayed"].includes(result.status))
    throw new Error(`Agent evaluation stopped with status ${result.status}.`)
  return { text: result.text, traceId: result.traceId, traceIds: result.traceId ? [result.traceId] : [], journey: undefined }
}

import { createHash } from "node:crypto"
import { z } from "zod"
import type { AppDefinition } from "@/src/lib/playground/contracts"
import {
  buildChannelSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { getTracerProjectId, type TracerDatabase } from "../tracer/db"
import { validation } from "../tracer/errors"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import { getAgent } from "./agents"

export const agentEvaluationPrefix = "build-agent."
const caseSchema = z.union([
  z.string().trim().min(1).max(20_000),
  z
    .object({
      message: z.string().trim().min(1).max(20_000),
      channel: buildChannelSchema.default("web"),
    })
    .strict(),
])

/** The existing eval executor pins this definition and checks it before dispatch. */
export async function resolveAgentEvaluation(
  database: TracerDatabase,
  id: string,
) {
  const projectId = getTracerProjectId(database)
  const agent = await getAgent({ database, projectId }, id)
  if (!agent.appliedRevision)
    throw validation("Apply the agent before running an evaluation.")
  const definition: AppDefinition = {
    id: `${agentEvaluationPrefix}${id}`,
    name: agent.name,
    mode: "input",
    revision: agent.appliedRevision,
    inputSchema: z.toJSONSchema(caseSchema, { target: "draft-7", io: "input" }),
    outputSchema: { type: "string" },
    evaluatorIds: [],
    internalTracing: true,
    codeProvenance: {
      source: "declared",
      fingerprint: createHash("sha256")
        .update(canonicalJson(agent.appliedConfiguration))
        .digest("hex"),
    },
  }
  return { definition, buildAgent: { database, agent } }
}

/** Each frozen case gets its own conversation and the real knowledge/model path. */
export async function executeAgentEvaluation(
  target: { database: TracerDatabase; agent: ManagedAgent },
  input: unknown,
  callId: string,
  scope?: PromptRunScope,
) {
  const parsed = caseSchema.parse(input)
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
      signal: AbortSignal.timeout(60_000),
      dependencies: {
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
  return { text: result.text, traceId: result.traceId }
}

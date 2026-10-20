import { createHash, randomUUID } from "node:crypto"
import { executeAppAction } from "../integrations/service"
import { beginModelUsage, finishModelUsage } from "../usage"

import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI } from "@ai-sdk/openai"
import {
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type LanguageModelCallEndEvent,
} from "ai"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { getModels } from "tokenlens/models"

import {
  buildChannelSchema,
  procedureStepSchema,
  type ActionDefinition,
  type ActionRecord,
  type ManagedAgent,
  type ProcedureStep,
  type ProcedureRecord,
} from "@/src/lib/build/contracts"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  type ModelProvider,
} from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import { validateSchema } from "@/src/server/playground/schema"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import { createAiTelemetry } from "@/src/server/tracer/ai-telemetry"
import { getAgent } from "../agents"
import { getRuntimeAppliedDefinitions } from "../definitions"
import type { BuildContext } from "../context"
import { publicHttpRequest } from "../http"
import { retrieveGroundedKnowledge } from "../knowledge/service"
import {
  collectData,
  createContact,
  updateContact,
  upsertLead,
} from "../operations/contacts"
import { pinContinuationWidgets } from "./continuations"
import {
  ConversationBusyError,
  ConversationBudgetExceededError,
  ConversationHumanOwnedError,
  ConversationOwnershipLostError,
  ConversationService,
  type ConversationContext,
} from "../conversations"
import type {
  Conversation,
  ConversationContent,
  ConversationMessage,
  ConversationToolCall,
  ConversationTurn,
} from "../conversation-schema"

export type BuildRuntimeContext = ConversationContext

export type RuntimeAgent = Pick<
  ManagedAgent,
  | "id"
  | "projectId"
  | "name"
  | "slug"
  | "currentRevision"
  | "appliedRevision"
  | "configuration"
> & {
  /** Runtime always prefers the immutable applied snapshot when available. */
  appliedConfiguration?: ManagedAgent["configuration"]
}

export type RuntimeKnowledgeResult = {
  text?: string
  documents?: Array<Record<string, unknown>>
  snapshotId?: string | null
}

export type RuntimeActionExecutionResult = {
  output: unknown
  continuation?: RuntimeContinuation | null
  status?: Extract<
    ConversationToolCall["status"],
    "completed" | "failed" | "awaiting_client"
  >
}

export type RuntimeBudgetReservation = {
  reservationId: string
  estimatedUsd: number
}

export type RuntimeDependencies = {
  resolveAgent?: (
    context: BuildRuntimeContext,
    agentId: string
  ) => Promise<RuntimeAgent>
  resolveActions?: (
    context: BuildRuntimeContext,
    agent: RuntimeAgent
  ) => Promise<ActionRecord[]>
  resolveProcedures?: (
    context: BuildRuntimeContext,
    agent: RuntimeAgent
  ) => Promise<ProcedureRecord[]>
  retrieveKnowledge?: (input: {
    context: BuildRuntimeContext
    agent: RuntimeAgent
    conversation: Conversation
    query: string
    signal?: AbortSignal
  }) => Promise<RuntimeKnowledgeResult | null>
  /** Optional organization-level budget/rate admission. Throw to deny a turn. */
  checkBudget?: (input: {
    context: BuildRuntimeContext
    agent: RuntimeAgent
    conversation: Conversation
    input: string
  }) => Promise<void>
  /** Optional atomic reservation used when an agent has a daily USD cap. */
  reserveBudget?: (input: {
    context: BuildRuntimeContext
    agent: RuntimeAgent
    conversation: Conversation
    input: string
    estimatedUsd: number
  }) => Promise<RuntimeBudgetReservation>
  /** Settles or releases the reservation after the provider returns. */
  settleBudget?: (input: {
    context: BuildRuntimeContext
    agent: RuntimeAgent
    conversation: Conversation
    reservationId: string
    actualUsd: number | null
    failed: boolean
  }) => Promise<void>
  /** The configured model catalog can provide a conservative preflight quote. */
  estimateCostUsd?: (input: {
    agent: RuntimeAgent
    channel?: string
    input: string
    maxOutputTokens: number
  }) => number | null
  /** Injected only by tests; production uses the project provider resolver. */
  generateText?: typeof generateText
  /**
   * Server-internal action boundary override. Simulation workers use this to
   * keep the real model/tool loop while replacing every external side effect
   * with a persisted test mock. Ordinary channel/runtime callers leave it
   * unset and use the configured action transport below.
   */
  executeAction?: (input: {
    context: BuildRuntimeContext
    service: ConversationService
    conversation: Conversation
    turn: ConversationTurn
    action: ActionDefinition
    input: Record<string, unknown>
    toolCallId: string
    signal?: AbortSignal
  }) => Promise<RuntimeActionExecutionResult>
  fetch?: typeof fetch
}

export const runAgentTurnInputSchema = z
  .object({
    agentId: z.string().min(1).max(200),
    channel: buildChannelSchema,
    conversationId: z.string().min(1).max(200).optional(),
    externalConversationId: z.string().min(1).max(500).optional(),
    requestKey: z.string().min(1).max(500),
    message: z.union([
      z.string().max(100_000),
      z.array(z.record(z.string(), z.json())).max(100),
    ]),
    metadata: z.record(z.string().max(200), z.json()).default({}),
  })
  .strict()

export type RunAgentTurnInput = z.input<typeof runAgentTurnInputSchema>

export type RuntimeContinuation = {
  type:
    | "client_action"
    | "widget"
    | "form"
    | "handoff"
    | "approval_required"
    | "wait"
  actionId?: string
  /** Opaque one-shot capability used to resume a persisted client action. */
  continuationId?: string
  eventName?: string
  widgetId?: string
  input?: Record<string, unknown>
  fields?: unknown[]
  submitActionId?: string | null
  title?: string
  submitLabel?: string
  teamId?: string | null
  priority?: "low" | "normal" | "high" | "urgent"
  seconds?: number
  message?: string
  /** Internal bounded cursor used to resume a paused procedure exactly once. */
  procedureCursor?: RuntimeProcedureCursor
  /** Earliest time an authenticated wait resume may claim this continuation. */
  resumeAt?: string
}

type RuntimeProcedureCursor = {
  procedureId: string
  procedureRevision: number
  remainingSteps: ProcedureStep[]
}

type RuntimeWidgetInteraction = {
  actionId: string
  input: Record<string, unknown>
  widgetId?: string
  continuationId?: string
}

export type RunAgentTurnResult = {
  status:
    | "completed"
    | "awaiting_client"
    | "handed_off"
    | "blocked"
    | "replayed"
    | "busy"
  conversation: Conversation
  turn: ConversationTurn
  message: ConversationMessage | null
  text: string
  continuations: RuntimeContinuation[]
  toolCalls: ConversationToolCall[]
  traceId: string | null
  usage: Record<string, unknown>
  replayed: boolean
}

export class BuildRuntimeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "BuildRuntimeError"
  }
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new BuildRuntimeError("TURN_CANCELLED", "The turn was cancelled.")
}

class GuardrailBlockedError extends BuildRuntimeError {
  constructor(message: string) {
    super("GUARDRAIL_BLOCKED", message)
    this.name = "GuardrailBlockedError"
  }
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

// Runtime snapshots and durable tool-call records may be inspected by support
// tooling. Keep credential-shaped values out of those records even when a
// customer supplied metadata or action input contains one. HTTP action
// credentials are decrypted only at invocation time and never pass through
// this serializer.
const RUNTIME_SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|secret|token|private[-_]?key|sign(?:ing)?[-_]?key|cookie|webhook)/i

type RuntimeJsonValue = z.infer<ReturnType<typeof z.json>>
type RuntimeJsonRecord = Record<string, RuntimeJsonValue>

function redactKnownSecretText(value: string, knownSecrets: readonly string[]) {
  return knownSecrets.reduce((redacted, secret) => {
    const normalized = secret.trim()
    if (!normalized || normalized.length < 2) return redacted
    return redacted.split(normalized).join("__REDACTED__")
  }, value)
}

function redactRuntimeText(value: string, knownSecrets: readonly string[]) {
  const redacted = redactRuntimeSecrets(value, knownSecrets)
  return typeof redacted === "string" ? redacted : ""
}

function redactRuntimeSecrets(
  value: unknown,
  knownSecrets: readonly string[] = []
): unknown {
  if (typeof value === "string")
    return redactKnownSecretText(value, knownSecrets)
  if (Array.isArray(value))
    return value.map((item) => redactRuntimeSecrets(item, knownSecrets))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      RUNTIME_SECRET_KEY.test(key)
        ? "__REDACTED__"
        : redactRuntimeSecrets(child, knownSecrets),
    ])
  )
}

function redactTraceValue(
  value: unknown,
  knownSecrets: readonly string[]
): unknown {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === "object") {
        const redacted = JSON.stringify(redactTraceValue(parsed, knownSecrets))
        return redacted === JSON.stringify(parsed) ? value : redacted
      }
    } catch {
      /* Ordinary text is not JSON. */
    }
    return redactKnownSecretText(value, knownSecrets)
  }
  if (Array.isArray(value))
    return value.map((item) => redactTraceValue(item, knownSecrets))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      RUNTIME_SECRET_KEY.test(key)
        ? "__REDACTED__"
        : redactTraceValue(child, knownSecrets),
    ])
  )
}

function redactTracePayload(payload: unknown, knownSecrets: readonly string[]) {
  const data = payload as Record<string, unknown>
  const attributes = data.attributes as Record<string, unknown> | undefined
  return {
    ...data,
    ...(data.input === undefined
      ? {}
      : { input: redactTraceValue(data.input, knownSecrets) }),
    ...(data.output === undefined
      ? {}
      : { output: redactTraceValue(data.output, knownSecrets) }),
    ...(attributes
      ? {
          attributes: Object.fromEntries(
            Object.entries(attributes)
              // Provider exceptions can contain request bodies and credentials. Preserve
              // status and HTTP codes, following the runtime's safe-error contract.
              .filter(
                ([key]) => key !== "otel.events" && key !== "error.message"
              )
              .map(([key, value]) => [
                key,
                redactTraceValue(value, knownSecrets),
              ])
          ),
        }
      : {}),
  }
}

function persistedRuntimeValue(
  value: unknown,
  knownSecrets: readonly string[] = []
): RuntimeJsonValue {
  const serialized = JSON.stringify(redactRuntimeSecrets(value, knownSecrets))
  return (
    serialized === undefined ? null : JSON.parse(serialized)
  ) as RuntimeJsonValue
}

function persistedRuntimeRecord(
  value: unknown,
  knownSecrets: readonly string[] = []
): RuntimeJsonRecord {
  const redacted = redactRuntimeSecrets(value, knownSecrets)
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (persistedRuntimeValue(redacted, knownSecrets) as RuntimeJsonRecord)
    : {}
}

function persistedProcedureCursor(
  cursor: RuntimeProcedureCursor,
  knownSecrets: readonly string[] = []
): RuntimeProcedureCursor {
  return {
    procedureId: cursor.procedureId,
    procedureRevision: cursor.procedureRevision,
    remainingSteps: persistedRuntimeValue(
      cursor.remainingSteps,
      knownSecrets
    ) as ProcedureStep[],
  }
}

function parseProcedureCursor(value: unknown): RuntimeProcedureCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.procedureId !== "string" ||
    !candidate.procedureId.trim() ||
    typeof candidate.procedureRevision !== "number" ||
    !Number.isInteger(candidate.procedureRevision) ||
    candidate.procedureRevision < 1 ||
    !Array.isArray(candidate.remainingSteps)
  )
    return null
  try {
    return {
      procedureId: candidate.procedureId.trim(),
      procedureRevision: candidate.procedureRevision,
      remainingSteps: procedureStepSchema
        .array()
        .max(100)
        .parse(candidate.remainingSteps),
    }
  } catch {
    return null
  }
}

function actionSecretValues(action: ActionDefinition): string[] {
  if (action.type !== "http") return []
  return Object.values(action.headers)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)
}

function runtimeFailureEventId(
  eventType: "agent_failed" | "tool_failed",
  key: string,
  projectId: string
) {
  return `runtime_${eventType}_${createHash("sha256")
    .update(`${projectId}:${eventType}:${key}`)
    .digest("hex")}`
}

async function recordRuntimeFailureEvent(
  context: BuildRuntimeContext,
  input: {
    eventType: "agent_failed" | "tool_failed"
    key: string
    conversation: Conversation
    question: string
    payload: Record<string, unknown>
  }
) {
  const question = input.question.slice(0, 4_000)
  const payload = persistedRuntimeValue({
    question,
    ...input.payload,
  })
  await context.database.execute(sql`
    INSERT INTO build_operation_events
      (id, project_id, event_type, conversation_id, channel, payload_json)
    VALUES
      (${runtimeFailureEventId(input.eventType, input.key, context.projectId)},
       ${context.projectId}, ${input.eventType}, ${input.conversation.id},
       ${input.conversation.channel}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `)
}

function textFromContent(content: ConversationContent | string): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return ""
        if (part.type === "text") return part.text
        if (part.type === "file" || part.type === "image")
          return `[${part.type}]`
        return ""
      })
      .join(" ")
  return JSON.stringify(content)
}

function safeError(error: unknown) {
  if (error instanceof GuardrailBlockedError) {
    return { kind: error.code, message: error.message }
  }
  if (error instanceof BuildRuntimeError) {
    const publicMessages: Record<string, string> = {
      ACTION_UNCERTAIN:
        "The action may have reached its destination, but Datool did not receive a definitive response.",
      ACTION_FAILED: "The action failed.",
      MODEL_NOT_CONFIGURED:
        "Configure a model for this agent before running it.",
      MODEL_REQUEST_FAILED: "The agent model request failed.",
      PROCEDURE_NOT_FOUND:
        "The requested manual procedure is not available on this agent.",
      TURN_CANCELLED: "The turn was cancelled.",
    }
    return {
      kind: error.code,
      message: publicMessages[error.code] ?? error.message,
    }
  }
  return {
    kind: "runtime",
    // Provider, DNS, TLS and response bodies can contain credentials or other
    // customer data. Persist a stable category rather than the raw exception.
    message: "Agent execution failed.",
  }
}

function normalizeModel(
  model: string,
  provider: ModelProvider = GATEWAY_PROVIDER
) {
  const trimmed = model.trim()
  if (provider === OPENAI_PROVIDER && trimmed.startsWith(`${OPENAI_PROVIDER}/`))
    return trimmed.slice(`${OPENAI_PROVIDER}/`.length)
  if (
    provider === GATEWAY_PROVIDER &&
    trimmed.startsWith(`${GATEWAY_PROVIDER}/`)
  )
    return trimmed.slice(`${GATEWAY_PROVIDER}/`.length)
  return trimmed
}

type RuntimeProviderSelection = {
  provider: typeof GATEWAY_PROVIDER | typeof OPENAI_PROVIDER
  modelId: string
}

/** Resolve credentials from the agent's explicit provider selection. */
function runtimeProviderSelection(
  configuration: ReturnType<typeof runtimeConfiguration>
): RuntimeProviderSelection {
  // `project` is the project-managed model route. Datool currently stores
  // that route in the AI Gateway provider; the model id itself still carries
  // its upstream namespace (for example openai/gpt-4.1-mini).
  const provider =
    configuration.provider === "openai" ? OPENAI_PROVIDER : GATEWAY_PROVIDER
  return { provider, modelId: normalizeModel(configuration.model, provider) }
}

/**
 * TokenLens ships a versioned pricing snapshot. It is suitable for admission
 * estimates, while measured provider usage remains the source of truth when a
 * provider reports a cost. Unknown models fail closed when a daily budget is
 * configured instead of inventing a price.
 */
function defaultEstimateCostUsd(input: {
  agent: RuntimeAgent
  channel?: string
  input: string
  maxOutputTokens: number
}): number | null {
  const configuration = input.channel
    ? runtimeConfiguration(input.agent, input.channel)
    : (input.agent.appliedConfiguration ?? input.agent.configuration)
  let model = configuration.model.trim()
  // The model field may carry the gateway namespace even when the provider is
  // selected through the project route. TokenLens indexes the upstream model
  // catalog by provider/model, so strip the transport prefix before lookup.
  if (model.startsWith(`${GATEWAY_PROVIDER}/`))
    model = model.slice(`${GATEWAY_PROVIDER}/`.length)
  const pieces = model.split("/", 2)
  const provider = pieces.length === 2 ? pieces[0] : "openai"
  const modelId = pieces.length === 2 ? pieces[1] : model
  const catalog = getModels() as Record<
    string,
    { models?: Record<string, { cost?: { input?: number; output?: number } }> }
  >
  const entry = catalog[provider]?.models?.[modelId]
  const inputRate = entry?.cost?.input
  const outputRate = entry?.cost?.output
  if (
    typeof inputRate !== "number" ||
    !Number.isFinite(inputRate) ||
    inputRate < 0 ||
    typeof outputRate !== "number" ||
    !Number.isFinite(outputRate) ||
    outputRate < 0
  )
    return null
  const instructionTokens = Math.ceil(
    (configuration.instructions?.length ?? 0) / 4
  )
  const inputTokens = Math.ceil(input.input.length / 4) + instructionTokens
  return (
    (inputTokens * inputRate + input.maxOutputTokens * outputRate) / 1_000_000
  )
}

function runtimeConfiguration(agent: RuntimeAgent, channel: string) {
  const configuration = agent.appliedConfiguration ?? agent.configuration
  const override =
    configuration.channelOverrides[
      channel as keyof typeof configuration.channelOverrides
    ]
  if (!override) return configuration
  return {
    ...configuration,
    instructions: override.instructions ?? configuration.instructions,
    provider: override.provider ?? configuration.provider,
    model: override.model ?? configuration.model,
    temperature: override.temperature ?? configuration.temperature,
  }
}

function runtimeSnapshotConfiguration(agent: RuntimeAgent, channel: string) {
  // Keep the effective model/guardrail configuration for replay diagnostics,
  // but omit credential-shaped values from arbitrary metadata.
  return persistedRuntimeRecord(runtimeConfiguration(agent, channel))
}

function usageObject(usage: unknown): Record<string, unknown> {
  if (!usage || typeof usage !== "object") return {}
  const value = usage as Record<string, unknown>
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    reasoningTokens: value.reasoningTokens,
    cachedInputTokens: value.cachedInputTokens,
    costUsd: value.costUsd ?? value.cost ?? value.totalCostUsd,
  }
}

function usageCostUsd(result: unknown): number | null {
  if (!result || typeof result !== "object") return null
  const usage = (result as Record<string, unknown>).usage
  const providerMetadata = (result as Record<string, unknown>).providerMetadata
  const candidates: unknown[] = [
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>).costUsd
      : undefined,
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>).totalCostUsd
      : undefined,
    providerMetadata && typeof providerMetadata === "object"
      ? (providerMetadata as Record<string, unknown>).costUsd
      : undefined,
    providerMetadata && typeof providerMetadata === "object"
      ? (providerMetadata as Record<string, unknown>).totalCostUsd
      : undefined,
  ]
  const cost = candidates.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
  )
  return cost ?? null
}

function validateActionInput(action: ActionDefinition, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BuildRuntimeError(
      "INVALID_TOOL_INPUT",
      "Action input must be an object."
    )
  if (Object.keys(action.inputSchema).length)
    validateSchema(action.inputSchema, input)
}

function assertSafeActionUrl(raw: string) {
  const url = new URL(raw)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new BuildRuntimeError(
      "UNSAFE_ACTION_URL",
      "HTTP actions require an HTTP(S) URL without credentials or fragments."
    )
  return url
}

class BuildActionTransportError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean
  ) {
    super(message)
    this.name = "BuildActionTransportError"
  }
}

function templateValue(input: Record<string, unknown>, path?: string) {
  if (!path) return input
  let value: unknown = input
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function renderActionBody(
  template: string | null,
  input: Record<string, unknown>
): string {
  if (!template?.trim()) return JSON.stringify(input)
  const exact = /^{{\s*input(?:\.([A-Za-z0-9_.-]+))?\s*}}$/.exec(
    template.trim()
  )
  if (exact) return JSON.stringify(templateValue(input, exact[1]))
  const rendered = template.replace(
    /{{\s*input(?:\.([A-Za-z0-9_.-]+))?\s*}}/g,
    (_match, path: string | undefined) => {
      const value = templateValue(input, path)
      if (typeof value === "string") return JSON.stringify(value).slice(1, -1)
      return JSON.stringify(value)
    }
  )
  return rendered
}

async function invokeBuildHttp(
  action: Pick<
    Extract<ActionDefinition, { type: "http" }>,
    "url" | "method" | "timeoutMs" | "headers" | "bodyTemplate"
  >,
  input: Record<string, unknown>,
  context: {
    actionId: string
    conversationId: string
    turnId: string
    channel: string
    traceId?: string
    signal?: AbortSignal
  },
  call: { callId: string }
) {
  const body = renderActionBody(action.bodyTemplate, input)
  let response: Awaited<ReturnType<typeof publicHttpRequest>>
  try {
    response = await publicHttpRequest(action.url, {
      method: action.method,
      headers: {
        ...action.headers,
        "content-type": "application/json",
        "x-datool-action-id": context.actionId,
        "x-datool-call-id": call.callId,
        "x-datool-conversation-id": context.conversationId,
        "x-datool-turn-id": context.turnId,
        "x-datool-channel": context.channel,
        ...(context.traceId
          ? { "x-datool-invocation-trace-id": context.traceId }
          : {}),
      },
      body,
      timeoutMs: action.timeoutMs,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      signal: context.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    const uncertain =
      /request (?:failed|timed out|was cancelled)|response was interrupted|could not be decoded/i.test(
        message
      )
    throw new BuildActionTransportError(
      uncertain
        ? "The outbound action request did not complete."
        : "The outbound action request was rejected.",
      uncertain
    )
  }
  if (response.status < 200 || response.status >= 300)
    throw new BuildActionTransportError(
      "The outbound action returned an error response.",
      false
    )
  const text = Buffer.from(response.body).toString("utf8")
  let output: unknown = text
  try {
    output = JSON.parse(text)
  } catch {
    // Action responses may be plain text; keep the bounded body as a string.
  }
  return { output }
}

function actionContinuation(
  action: ActionDefinition,
  input: Record<string, unknown>,
  continuationId: string,
  knownSecrets: readonly string[] = [],
  procedureCursor?: RuntimeProcedureCursor
): RuntimeContinuation | null {
  const persistedInput = persistedRuntimeRecord(input, knownSecrets)
  const cursor = procedureCursor
    ? persistedProcedureCursor(procedureCursor, knownSecrets)
    : undefined
  const withCursor = <T extends RuntimeContinuation>(continuation: T): T =>
    cursor ? { ...continuation, procedureCursor: cursor } : continuation
  if (action.type === "client")
    return withCursor({
      type: "client_action",
      actionId: action.id,
      continuationId,
      eventName: action.eventName,
      input: persistedInput,
    })
  if (action.type === "widget")
    return withCursor({
      type: "widget",
      actionId: action.id,
      continuationId,
      widgetId: action.widgetId,
      eventName: action.eventName,
      input: persistedInput,
    })
  if (action.type === "form")
    return withCursor({
      type: "form",
      actionId: action.id,
      continuationId,
      fields: action.fields,
      submitActionId: action.submitActionId,
      title: action.name,
      submitLabel: action.submitLabel,
      input: persistedInput,
    })
  if (action.type === "handoff")
    return withCursor({
      type: "handoff",
      actionId: action.id,
      continuationId,
      teamId: action.teamId,
      priority: action.priority,
      message: action.message,
      input: persistedInput,
    })
  return null
}

function normalizeRuntimeContinuation(
  value: unknown,
  continuationId: string,
  knownSecrets: readonly string[] = [],
  procedureCursor?: RuntimeProcedureCursor
): RuntimeContinuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = persistedRuntimeRecord(value, knownSecrets)
  const type = candidate.type
  if (
    type !== "client_action" &&
    type !== "widget" &&
    type !== "form" &&
    type !== "handoff" &&
    type !== "approval_required" &&
    type !== "wait"
  )
    return null
  const persistedCursor =
    procedureCursor ?? parseProcedureCursor(candidate.procedureCursor)
  const normalized: RuntimeContinuation = {
    ...(candidate as RuntimeContinuation),
    type,
    continuationId,
  }
  if (persistedCursor)
    normalized.procedureCursor = persistedProcedureCursor(
      persistedCursor,
      knownSecrets
    )
  else delete normalized.procedureCursor
  return normalized
}

function persistedContinuations(
  toolCalls: ConversationToolCall[]
): RuntimeContinuation[] {
  return toolCalls.flatMap((call) => {
    const continuation = call.continuation
    if (!continuation || typeof continuation.type !== "string") return []
    const type = continuation.type
    if (
      type !== "client_action" &&
      type !== "widget" &&
      type !== "form" &&
      type !== "handoff" &&
      type !== "approval_required" &&
      type !== "wait"
    )
      return []
    return [continuation as RuntimeContinuation]
  })
}

function continuationMessageContent(
  continuations: RuntimeContinuation[]
): RuntimeJsonRecord {
  // Conversation content allows a JSON object, while a bare array would be
  // interpreted as user message parts and rejected by the ledger schema.
  return {
    continuations: JSON.parse(
      JSON.stringify(continuations)
    ) as RuntimeJsonValue,
  }
}

async function continuationMessageMetadata(
  context: BuildRuntimeContext,
  conversation: Conversation,
  turn: ConversationTurn,
  continuations: RuntimeContinuation[]
): Promise<RuntimeJsonRecord> {
  if (!continuations.length) return {}
  const pinned = await pinContinuationWidgets(context, {
    channel: conversation.channel,
    agentId: conversation.agentId,
    agentRevision: turn.snapshot.agentRevision,
    continuations,
  })
  return continuationMessageContent(pinned)
}

function widgetInteraction(
  value: Record<string, unknown>
): RuntimeWidgetInteraction | null {
  const raw = value.widgetInteraction
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const interaction = raw as Record<string, unknown>
  if (typeof interaction.actionId !== "string" || !interaction.actionId.trim())
    return null
  const input = interaction.input
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  return {
    actionId: interaction.actionId.trim(),
    input: input as Record<string, unknown>,
    widgetId:
      typeof interaction.widgetId === "string" && interaction.widgetId.trim()
        ? interaction.widgetId.trim()
        : undefined,
    continuationId:
      typeof interaction.continuationId === "string" &&
      interaction.continuationId.trim()
        ? interaction.continuationId.trim()
        : undefined,
  }
}

function validateFormSubmission(
  action: Extract<ActionDefinition, { type: "form" }>,
  input: Record<string, unknown>
) {
  const fieldNames = new Set(action.fields.map((field) => field.name))
  if (
    Object.keys(input).some((key) => !fieldNames.has(key)) ||
    action.fields.some((field) => {
      const value = input[field.name]
      return (
        field.required &&
        (value === undefined || value === null || value === "")
      )
    })
  )
    throw new BuildRuntimeError(
      "INVALID_FORM_INPUT",
      "The submitted form data is invalid."
    )

  for (const field of action.fields) {
    const value = input[field.name]
    if (value === undefined || value === null || value === "") continue
    if (
      ["text", "email", "phone", "select", "textarea"].includes(field.type) &&
      typeof value !== "string"
    )
      throw new BuildRuntimeError(
        "INVALID_FORM_INPUT",
        "The submitted form data is invalid."
      )
    if (
      field.type === "number" &&
      ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "number"
          ? !Number.isFinite(value)
          : !value.trim() || !Number.isFinite(Number(value))))
    )
      throw new BuildRuntimeError(
        "INVALID_FORM_INPUT",
        "The submitted form data is invalid."
      )
    if (
      field.type === "select" &&
      (typeof value !== "string" ||
        (field.options.length > 0 && !field.options.includes(value)))
    )
      throw new BuildRuntimeError(
        "INVALID_FORM_INPUT",
        "The submitted form data is invalid."
      )
    if (
      field.type === "email" &&
      (typeof value !== "string" || !/^\S+@\S+\.\S+$/.test(value))
    )
      throw new BuildRuntimeError(
        "INVALID_FORM_INPUT",
        "The submitted form data is invalid."
      )
  }
}

function actionOutputText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const record = value as Record<string, unknown>
  if (
    typeof record.type === "string" &&
    [
      "client_action",
      "widget",
      "form",
      "handoff",
      "approval_required",
      "wait",
    ].includes(record.type)
  )
    return ""
  for (const key of ["text", "message", "reply", "content"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return JSON.stringify(value).slice(0, 100_000)
}

function isUncertainHttpFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    message.includes("timed out") ||
    message.includes("failed") ||
    message.includes("interrupted") ||
    message.includes("http ")
  )
}

/** Conservative local spam signal used at the configured sampling interval. */
function likelySpam(input: string) {
  const normalized = input.trim().toLocaleLowerCase()
  if (!normalized) return false
  const urls = normalized.match(/https?:\/\/\S+/g)?.length ?? 0
  if (urls >= 4) return true
  if (/(.)\1{14,}/u.test(normalized)) return true
  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length >= 8) {
    const counts = new Map<string, number>()
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    if (Math.max(...counts.values()) >= Math.ceil(words.length * 0.7))
      return true
  }
  return false
}

function procedureMatches(
  procedure: ProcedureRecord,
  input: string,
  metadata: Record<string, unknown>,
  requiredProcedureId?: string,
  selectedProcedureId?: string
) {
  if (requiredProcedureId && procedure.id !== requiredProcedureId) return false
  if (selectedProcedureId && procedure.id !== selectedProcedureId) return false
  if (!procedure.definition.enabled) return false
  const trigger = procedure.definition.trigger
  if (requiredProcedureId && trigger.type !== "manual") return false
  if (selectedProcedureId && trigger.type !== "intent") return false
  if (selectedProcedureId) return true
  if (trigger.type === "keyword")
    return input.toLocaleLowerCase().includes(trigger.value.toLocaleLowerCase())
  if (trigger.type === "intent") return metadata.intent === trigger.value
  if (trigger.type === "event")
    return (
      metadata.event === trigger.value || metadata.eventName === trigger.value
    )
  return (
    metadata.procedureId === procedure.id ||
    metadata.procedure === trigger.value
  )
}

function assertRuntimeDefinitionScope(
  agent: RuntimeAgent,
  actions: ActionRecord[],
  procedures: ProcedureRecord[]
) {
  for (const action of actions) {
    if (
      action.projectId !== agent.projectId ||
      action.agentId !== agent.id ||
      action.id !== action.definition.id
    )
      throw new BuildRuntimeError(
        "DEFINITION_SCOPE_MISMATCH",
        "The agent definition catalog is not scoped to this agent."
      )
  }
  for (const procedure of procedures) {
    if (
      procedure.projectId !== agent.projectId ||
      procedure.agentId !== agent.id
    )
      throw new BuildRuntimeError(
        "DEFINITION_SCOPE_MISMATCH",
        "The agent procedure catalog is not scoped to this agent."
      )
  }
}

function evaluateBranch(condition: string, variables: Record<string, unknown>) {
  const trimmed = condition.trim()
  const parts = trimmed.split(/\s*&&\s*/g)
  return parts.every((part) => {
    const match = /^(?:([A-Za-z_][\w.-]*)\s*(==|!=)\s*)?(.*)$/.exec(part.trim())
    if (!match) return false
    const [, key, operator, rawExpected] = match
    if (!key) return Boolean(variables[rawExpected.trim()])
    const expectedText = rawExpected.trim().replace(/^['"]|['"]$/g, "")
    const actual = variables[key]
    const equal = String(actual ?? "") === expectedText
    return operator === "!=" ? !equal : equal
  })
}

type ProcedureResult = {
  text: string
  continuations: RuntimeContinuation[]
  stopped: boolean
  handoff: boolean
  handoffOwnerId: string | null
}

export type RunAgentTurnOptions = {
  dependencies?: RuntimeDependencies
  conversationService?: ConversationService
  /** Server-internal override for tests or an already-authorized worker. */
  agent?: RuntimeAgent
  signal?: AbortSignal
  maxToolSteps?: number
  /** Set only by a channel adapter after authenticating its ingress metadata. */
  trustedCountry?: string
  /** Metadata authenticated by a server-side adapter; public input is never trusted for triggers. */
  trustedMetadata?: Record<string, unknown>
  /** A human approval asserted by an authenticated operator boundary. */
  trustedApproval?: { actionId: string; continuationId?: string }
  /** An authenticated scheduler/operator resume for a durable wait. */
  trustedWaitContinuationId?: string
  /** Authenticated manual procedure operation; never accepted from raw input. */
  requiredProcedureId?: string
}

async function traceStart(
  context: BuildRuntimeContext,
  agent: RuntimeAgent,
  conversation: Conversation,
  turn: ConversationTurn,
  input: string
) {
  try {
    const service = new TracerService(context.database)
    const session = await runTracerEffect(
      service.createSession({
        id: conversation.id,
        name: `${agent.name} · ${conversation.channel}`,
        attributes: asJsonObject({
          "build.agent.id": agent.id,
          "build.conversation.id": conversation.id,
          "build.channel": conversation.channel,
        }),
      })
    ).catch(async () => runTracerEffect(service.getSession(conversation.id)))
    const trace = await runTracerEffect(
      service.createTrace({
        id: `build_${turn.id}`,
        sessionId: session.id,
        name: agent.name,
        operation: "build.agent.turn",
        group: {
          type: "agent",
          name: agent.slug || agent.name,
          version: String(agent.appliedRevision || agent.currentRevision),
        },
        input: input as JsonValue,
        status: "running",
        attributes: asJsonObject({
          "datool.span.kind": "agent",
          "build.agent.id": agent.id,
          "build.conversation.id": conversation.id,
          "build.turn.id": turn.id,
          "build.channel": conversation.channel,
          "build.agent.revision":
            agent.appliedRevision || agent.currentRevision,
        }),
      })
    )
    return { service, trace, session }
  } catch {
    return null
  }
}

async function traceFinish(
  started: Awaited<ReturnType<typeof traceStart>>,
  output: string,
  status: "completed" | "errored" | "cancelled",
  usage: Record<string, unknown>,
  toolCalls: ConversationToolCall[]
) {
  if (!started) return
  try {
    const attributes = asJsonObject({
      ...started.trace.attributes,
      "build.usage": usage,
      "build.tool.count": toolCalls.length,
    })
    await runTracerEffect(
      started.service.patchTrace(started.trace.id, {
        output: output as JsonValue,
        status,
        endedAt: new Date().toISOString(),
        attributes,
      })
    )
  } catch {
    // Analytical projection failure must never erase a durable customer turn.
  }
}

async function executeAction(
  context: BuildRuntimeContext,
  service: ConversationService,
  conversation: Conversation,
  turn: ConversationTurn,
  action: ActionDefinition,
  input: Record<string, unknown>,
  options: {
    dependencies: RuntimeDependencies
    toolCallId: string
    question?: string
    continuationId?: string
    procedureCursor?: RuntimeProcedureCursor
    requireHumanForActions?: boolean
    allowApproval?: boolean
    signal?: AbortSignal
  }
) {
  assertNotCancelled(options.signal)
  const knownSecrets = actionSecretValues(action)
  await service.recordToolCallStart({
    conversationId: conversation.id,
    turnId: turn.id,
    toolCallId: options.toolCallId,
    actionId: action.id,
    args: persistedRuntimeRecord(input, knownSecrets),
    ownerFence: turn.ownerFence,
  })
  try {
    validateActionInput(action, input)
  } catch (error) {
    await service.recordToolCallFinish({
      conversationId: conversation.id,
      turnId: turn.id,
      toolCallId: options.toolCallId,
      status: "failed",
      error: safeError(error),
      ownerFence: turn.ownerFence,
    })
    await recordRuntimeFailureEvent(context, {
      eventType: "tool_failed",
      key: `${turn.id}:${options.toolCallId}`,
      conversation,
      question: options.question ?? "",
      payload: {
        actionId: action.id,
        toolCallId: options.toolCallId,
        turnId: turn.id,
        error: safeError(error),
      },
    }).catch(() => undefined)
    throw error
  }
  const continuationId = options.continuationId ?? randomUUID()
  if (
    options.requireHumanForActions &&
    action.type !== "handoff" &&
    !options.allowApproval
  ) {
    const approval: RuntimeContinuation = {
      type: "approval_required",
      actionId: action.id,
      continuationId,
      input: persistedRuntimeRecord(input, knownSecrets),
      message: "A teammate must approve this action before it runs.",
      ...(options.procedureCursor
        ? {
            procedureCursor: persistedProcedureCursor(
              options.procedureCursor,
              knownSecrets
            ),
          }
        : {}),
    }
    await service.recordToolCallFinish({
      conversationId: conversation.id,
      turnId: turn.id,
      toolCallId: options.toolCallId,
      status: "awaiting_client",
      output: approval,
      continuation: approval,
      ownerFence: turn.ownerFence,
    })
    return {
      output: approval,
      continuation: approval,
      status: "awaiting_client" as const,
    }
  }
  if (options.dependencies.executeAction) {
    try {
      const result = await options.dependencies.executeAction({
        context,
        service,
        conversation,
        turn,
        action,
        input,
        toolCallId: options.toolCallId,
        signal: options.signal,
      })
      const continuation = result.continuation
        ? normalizeRuntimeContinuation(
            redactRuntimeSecrets(result.continuation, knownSecrets),
            continuationId,
            knownSecrets,
            options.procedureCursor
          )
        : null
      const status = result.status ?? "completed"
      const output = redactRuntimeSecrets(result.output, knownSecrets)
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        status,
        output,
        continuation,
        ownerFence: turn.ownerFence,
      })
      if (status === "failed")
        await recordRuntimeFailureEvent(context, {
          eventType: "tool_failed",
          key: `${turn.id}:${options.toolCallId}`,
          conversation,
          question: options.question ?? "",
          payload: {
            actionId: action.id,
            toolCallId: options.toolCallId,
            turnId: turn.id,
            error: {
              kind: "ACTION_FAILED",
              message: "The action failed.",
            },
          },
        }).catch(() => undefined)
      return { output, continuation, status }
    } catch (error) {
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        status: "failed",
        error: safeError(error),
        ownerFence: turn.ownerFence,
      })
      await recordRuntimeFailureEvent(context, {
        eventType: "tool_failed",
        key: `${turn.id}:${options.toolCallId}`,
        conversation,
        question: options.question ?? "",
        payload: {
          actionId: action.id,
          toolCallId: options.toolCallId,
          turnId: turn.id,
          error: safeError(error),
        },
      }).catch(() => undefined)
      throw error
    }
  }
  const continuation = actionContinuation(
    action,
    input,
    continuationId,
    knownSecrets,
    options.procedureCursor
  )
  if (action.type !== "http" && action.type !== "integration") {
    try {
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        status: action.type === "handoff" ? "completed" : "awaiting_client",
        output: continuation,
        continuation,
        ownerFence: turn.ownerFence,
      })
      return {
        output: continuation,
        continuation,
        status:
          action.type === "handoff"
            ? ("completed" as const)
            : ("awaiting_client" as const),
      }
    } catch (error) {
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        status: "failed",
        error: safeError(error),
        ownerFence: turn.ownerFence,
      })
      throw error
    }
  }
  try {
    if (action.type === "integration") {
      const result = await executeAppAction(context, {
        connectionId: action.connectionId,
        toolSlug: action.toolSlug,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        arguments: input,
        signal: options.signal,
      })
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: options.toolCallId,
        status: result.status,
        output: result.output,
        ownerFence: turn.ownerFence,
      })
      return { ...result, continuation: null }
    }
    assertSafeActionUrl(action.url)
    const result = await invokeBuildHttp(
      {
        url: action.url,
        method: action.method,
        timeoutMs: action.timeoutMs,
        headers: action.headers,
        bodyTemplate: action.bodyTemplate,
      },
      input,
      {
        actionId: action.id,
        conversationId: conversation.id,
        turnId: turn.id,
        channel: conversation.channel,
        traceId: `build_${turn.id}`,
        signal: options.signal,
      },
      { callId: options.toolCallId }
    )
    if (Object.keys(action.responseSchema).length)
      validateSchema(action.responseSchema, result.output)
    const output = redactRuntimeSecrets(result.output, knownSecrets)
    await service.recordToolCallFinish({
      conversationId: conversation.id,
      turnId: turn.id,
      toolCallId: options.toolCallId,
      status: "completed",
      output,
      ownerFence: turn.ownerFence,
    })
    return {
      output,
      continuation: null,
      status: "completed" as const,
    }
  } catch (error) {
    const uncertain =
      Boolean((error as { uncertain?: unknown })?.uncertain) ||
      isUncertainHttpFailure(error)
    const status = uncertain ? "uncertain" : "failed"
    await service.recordToolCallFinish({
      conversationId: conversation.id,
      turnId: turn.id,
      toolCallId: options.toolCallId,
      status,
      error: safeError(error),
      ownerFence: turn.ownerFence,
    })
    await recordRuntimeFailureEvent(context, {
      eventType: "tool_failed",
      key: `${turn.id}:${options.toolCallId}`,
      conversation,
      question: options.question ?? "",
      payload: {
        actionId: action.id,
        toolCallId: options.toolCallId,
        turnId: turn.id,
        error: safeError(error),
      },
    }).catch(() => undefined)
    throw new BuildRuntimeError(
      uncertain ? "ACTION_UNCERTAIN" : "ACTION_FAILED",
      uncertain
        ? "The action may have reached its destination, but Datool did not receive a definitive response. It was not retried."
        : "The action failed."
    )
  }
}

async function runProcedure(
  context: BuildRuntimeContext,
  service: ConversationService,
  conversation: Conversation,
  turn: ConversationTurn,
  input: string,
  procedures: ProcedureRecord[],
  actions: Map<string, ActionRecord>,
  dependencies: RuntimeDependencies,
  requireHumanForActions: boolean,
  signal?: AbortSignal,
  metadata: Record<string, unknown> = {},
  requiredProcedureId?: string,
  selectedProcedureId?: string,
  resumeCursor?: RuntimeProcedureCursor
): Promise<ProcedureResult | null> {
  const procedure = resumeCursor
    ? procedures.find(
        (item) =>
          item.id === resumeCursor.procedureId &&
          item.revision === resumeCursor.procedureRevision &&
          item.definition.enabled
      )
    : procedures.find((item) =>
        procedureMatches(
          item,
          input,
          metadata,
          requiredProcedureId,
          selectedProcedureId
        )
      )
  if (!procedure) return null
  let variables = {
    ...conversation.variables,
    ...procedure.definition.variables,
  }
  const text: string[] = []
  const continuations: RuntimeContinuation[] = []
  let handoff = false
  let handoffOwnerId: string | null = null
  const steps = resumeCursor
    ? [...resumeCursor.remainingSteps]
    : [...procedure.definition.steps]
  if (!resumeCursor) {
    for (const branch of procedure.definition.branches) {
      if (evaluateBranch(branch.condition, variables))
        steps.push(...branch.steps)
    }
  }
  for (const [stepIndex, step] of steps.entries()) {
    assertNotCancelled(signal)
    if (step.kind === "message") {
      text.push(step.content)
    } else if (step.kind === "set_variable") {
      variables = { ...variables, [step.name]: step.value }
      await service.setVariables(conversation.id, variables, turn.ownerFence)
    } else if (step.kind === "wait") {
      const continuationId = randomUUID()
      const continuation: RuntimeContinuation = {
        type: "wait",
        actionId: "__wait__",
        continuationId,
        seconds: step.seconds,
        // A zero-length wait is immediately resumable. Use the epoch for that
        // case so a small clock skew between the app and PostgreSQL cannot
        // strand an otherwise ready continuation behind `now()`.
        resumeAt:
          step.seconds <= 0
            ? new Date(0).toISOString()
            : new Date(Date.now() + step.seconds * 1000).toISOString(),
        procedureCursor: {
          procedureId: procedure.id,
          procedureRevision: procedure.revision,
          remainingSteps: steps.slice(stepIndex + 1),
        },
      }
      const toolCallId = `procedure_wait_${step.id}_${randomUUID()}`
      await service.recordToolCallStart({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId,
        actionId: "__wait__",
        args: { seconds: step.seconds },
        ownerFence: turn.ownerFence,
      })
      await service.recordToolCallFinish({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId,
        status: "awaiting_client",
        output: continuation,
        continuation,
        ownerFence: turn.ownerFence,
      })
      continuations.push(continuation)
      break
    } else {
      const action = actions.get(
        step.kind === "handoff" ? step.actionId : step.actionId
      )
      if (!action)
        throw new BuildRuntimeError(
          "ACTION_NOT_FOUND",
          `Procedure action '${step.actionId}' was not found.`
        )
      const result = await executeAction(
        context,
        service,
        conversation,
        turn,
        action.definition,
        step.kind === "action" ? (step.input as Record<string, unknown>) : {},
        {
          dependencies,
          toolCallId: `procedure_${step.id}_${randomUUID()}`,
          question: input,
          requireHumanForActions,
          procedureCursor:
            stepIndex < steps.length - 1
              ? {
                  procedureId: procedure.id,
                  procedureRevision: procedure.revision,
                  remainingSteps: steps.slice(stepIndex + 1),
                }
              : undefined,
          signal,
        }
      )
      if (action.definition.type === "handoff") {
        handoff = true
        handoffOwnerId = action.definition.teamId
      }
      if (result.continuation) {
        continuations.push(result.continuation)
        if (
          result.status === "awaiting_client" ||
          result.continuation.type === "handoff" ||
          result.continuation.type === "approval_required"
        )
          break
      }
      if (action.definition.type === "handoff") {
        break
      }
    }
  }
  return {
    text: text.join("\n\n"),
    continuations,
    stopped: true,
    handoff,
    handoffOwnerId,
  }
}

/**
 * The one server entrypoint shared by Build playground, MCP and channel
 * adapters. It admits/persists the user event before contacting a model, runs
 * a bounded AI SDK tool loop, and commits output only while its ownership
 * fence remains current.
 */
export async function runAgentTurn(
  context: BuildRuntimeContext,
  rawInput: RunAgentTurnInput,
  options: RunAgentTurnOptions = {}
): Promise<RunAgentTurnResult> {
  const dependencies = options.dependencies ?? {}
  const parsed = runAgentTurnInputSchema.parse(rawInput)
  const service =
    options.conversationService ?? new ConversationService(context)
  const resolveAgent =
    dependencies.resolveAgent ??
    ((ctx: BuildRuntimeContext, agentId: string) =>
      getAgent(ctx as BuildContext, agentId))
  const suppliedAgent = options.agent
  let agent: RuntimeAgent
  try {
    agent = suppliedAgent ?? (await resolveAgent(context, parsed.agentId))
  } catch (error) {
    if ((error as { code?: unknown })?.code === "NOT_FOUND")
      throw new BuildRuntimeError(
        "AGENT_NOT_FOUND",
        "The managed agent was not found."
      )
    throw error
  }
  if (!agent)
    throw new BuildRuntimeError(
      "AGENT_NOT_FOUND",
      "A managed agent resolver is required to run a Build agent."
    )
  if (agent.projectId !== context.projectId)
    throw new BuildRuntimeError(
      "TENANT_MISMATCH",
      "The managed agent belongs to another project."
    )
  const content = parsed.message as ConversationContent
  const inputText = textFromContent(content)
  const conversation = parsed.conversationId
    ? await service.require(parsed.conversationId)
    : await service.getOrCreate({
        agentId: agent.id,
        channel: parsed.channel,
        externalConversationId: parsed.externalConversationId,
        metadata: persistedRuntimeRecord(parsed.metadata),
      })
  if (
    conversation.agentId !== agent.id ||
    conversation.channel !== parsed.channel
  )
    throw new BuildRuntimeError(
      "CONVERSATION_MISMATCH",
      "Conversation does not belong to this agent/channel."
    )

  let admission: Awaited<ReturnType<ConversationService["startTurn"]>>
  try {
    admission = await service.startTurn(conversation.id, {
      requestKey: parsed.requestKey,
      input: content,
      metadata: persistedRuntimeRecord(parsed.metadata),
      sourceEventId: parsed.requestKey,
      snapshot: {
        agentId: agent.id,
        agentRevision: agent.appliedRevision || agent.currentRevision,
        configuration: runtimeSnapshotConfiguration(agent, parsed.channel),
        channel: parsed.channel,
      },
    })
  } catch (error) {
    if (error instanceof ConversationHumanOwnedError)
      throw new BuildRuntimeError("CONVERSATION_HUMAN_OWNED", error.message)
    throw error
  }
  if (admission.kind === "busy")
    return {
      status: "busy",
      conversation: admission.conversation,
      turn: admission.turn,
      message: null,
      text: "",
      continuations: [],
      toolCalls: [],
      traceId: admission.turn.traceId,
      usage: admission.turn.usage,
      replayed: false,
    }
  if (admission.kind === "replay") {
    const text = admission.outputMessage
      ? textFromContent(admission.outputMessage.content)
      : ""
    const toolCalls = await service.listToolCalls(admission.conversation.id)
    const replayContinuations = persistedContinuations(
      toolCalls.filter((call) => call.turnId === admission.turn.id)
    )
    const replayHandoff = replayContinuations.find(
      (continuation) => continuation.type === "handoff"
    )
    let replayConversation = admission.conversation
    let replayStatus: RunAgentTurnResult["status"] = "replayed"
    // finishTurn and claim are separate ledger operations so a crash cannot
    // hold the conversation lock indefinitely. If the completed turn
    // persisted a handoff continuation but the claim did not commit, the same
    // request-key retry completes only that handoff, fenced to the exact
    // original AI epoch. It never re-executes a tool or trusts the current
    // conversation epoch.
    if (replayHandoff && admission.conversation.ownerType === "ai") {
      replayConversation = await service.claim(
        admission.conversation.id,
        {
          type: "human",
          id: replayHandoff.teamId ?? context.actorId ?? `team:${agent.id}`,
          reason: "Replayed agent handoff",
        },
        {
          expectedOwnerFence: admission.turn.ownerFence,
          expectedOwnerType: "ai",
          handoffTurnId: admission.turn.id,
        }
      )
      replayStatus = "handed_off"
    }
    return {
      status: replayStatus,
      conversation: replayConversation,
      turn: admission.turn,
      message: admission.outputMessage,
      text,
      continuations: replayContinuations,
      toolCalls,
      traceId: admission.turn.traceId,
      usage: admission.turn.usage,
      replayed: true,
    }
  }
  const turn = admission.turn
  let trace: Awaited<ReturnType<typeof traceStart>> = null
  const modelToolCalls: ConversationToolCall[] = []
  let handoffRequested = false
  let handoffOwnerId: string | null = null
  let budgetReservation: RuntimeBudgetReservation | null = null
  let modelExecutionStarted = false
  const settleBudget = async (actualUsd: number | null, failed: boolean) => {
    if (!budgetReservation) return
    if (dependencies.settleBudget) {
      await dependencies.settleBudget({
        context,
        agent,
        conversation,
        reservationId: budgetReservation.reservationId,
        actualUsd,
        failed,
      })
      return
    }
    await service.settleBudget({
      reservationId: budgetReservation.reservationId,
      ownerFence: turn.ownerFence,
      actualUsd,
      failed,
    })
  }
  try {
    assertNotCancelled(options.signal)
    const configuration = runtimeConfiguration(agent, parsed.channel)
    if (!configuration.channelAllowlist.includes(parsed.channel))
      throw new GuardrailBlockedError(
        "This agent is not enabled on this channel."
      )
    if (configuration.channelOverrides[parsed.channel]?.enabled === false)
      throw new GuardrailBlockedError(
        "This agent is not enabled on this channel."
      )
    const guardrails = configuration.guardrails
    if (inputText.length > guardrails.maxInputCharacters)
      throw new GuardrailBlockedError(
        "This message is longer than the agent allows."
      )
    const trustedCountry = options.trustedCountry?.trim().toUpperCase()
    if (
      trustedCountry &&
      /^[A-Z]{2}$/.test(trustedCountry) &&
      guardrails.blockedCountries.includes(trustedCountry)
    )
      throw new GuardrailBlockedError(
        "This channel is unavailable in your country."
      )
    if (
      guardrails.blockedTopics.some((topic) =>
        inputText.toLocaleLowerCase().includes(topic.toLocaleLowerCase())
      )
    )
      throw new GuardrailBlockedError("I can’t help with that request.")
    const previous = await service.getMessagesForModel(conversation.id)
    const userCount = previous.filter(
      (message) => message.role === "user"
    ).length
    if (userCount > guardrails.maxTurns)
      throw new GuardrailBlockedError(
        "This conversation has reached its turn limit."
      )
    if (
      guardrails.spamAfterMessages &&
      userCount % guardrails.spamAfterMessages === 0
    ) {
      const spamBlocked = likelySpam(inputText)
      const spamSnapshot = await service.setSnapshot(
        turn.id,
        {
          ...turn.snapshot,
          guardrailDecisions: {
            spam: {
              checked: true,
              blocked: spamBlocked,
              interval: guardrails.spamAfterMessages,
              checkedAt: new Date().toISOString(),
            },
          },
        },
        turn.ownerFence
      )
      turn.snapshot = spamSnapshot.snapshot
      if (spamBlocked)
        throw new GuardrailBlockedError("This message was flagged as spam.")
    }
    const admissionStats = await service.getTurnAdmissionStats(agent.id)
    if (admissionStats.requestsLastMinute > guardrails.requestsPerMinute)
      throw new GuardrailBlockedError(
        "Please wait before sending another message."
      )
    if (admissionStats.concurrentTurns > guardrails.maxConcurrentTurns)
      throw new GuardrailBlockedError(
        "This agent is handling its current requests. Please try again shortly."
      )
    if (
      guardrails.dailyTurnLimit !== null &&
      admissionStats.turnsToday > guardrails.dailyTurnLimit
    )
      throw new GuardrailBlockedError(
        "This agent has reached its daily message limit."
      )
    if (
      guardrails.dailyBudgetUsd !== null &&
      admissionStats.spendTodayUsd >= guardrails.dailyBudgetUsd
    )
      throw new GuardrailBlockedError(
        "This agent has reached its daily usage budget."
      )
    if (guardrails.dailyBudgetUsd !== null) {
      const estimateCostUsd =
        dependencies.estimateCostUsd ?? defaultEstimateCostUsd
      const estimatedUsd = estimateCostUsd({
        agent,
        channel: parsed.channel,
        input: inputText,
        maxOutputTokens: guardrails.maxOutputTokens,
      })
      if (
        estimatedUsd === null ||
        estimatedUsd === undefined ||
        !Number.isFinite(estimatedUsd) ||
        estimatedUsd < 0
      )
        throw new BuildRuntimeError(
          "BUDGET_UNAVAILABLE",
          "This agent's usage budget cannot be evaluated safely yet."
        )
      if (
        admissionStats.spendTodayUsd + estimatedUsd >
        guardrails.dailyBudgetUsd
      )
        throw new GuardrailBlockedError(
          "This agent has reached its daily usage budget."
        )
      const reserveBudget = dependencies.reserveBudget
        ? (input: {
            context: BuildRuntimeContext
            agent: RuntimeAgent
            conversation: Conversation
            input: string
            estimatedUsd: number
          }) => dependencies.reserveBudget!(input)
        : (input: {
            context: BuildRuntimeContext
            agent: RuntimeAgent
            conversation: Conversation
            input: string
            estimatedUsd: number
          }) =>
            service.reserveBudget({
              agentId: input.agent.id,
              conversationId: input.conversation.id,
              turnId: turn.id,
              ownerFence: turn.ownerFence,
              estimatedUsd: input.estimatedUsd,
              dailyLimitUsd: guardrails.dailyBudgetUsd as number,
            })
      try {
        budgetReservation = await reserveBudget({
          context,
          agent,
          conversation,
          input: inputText,
          estimatedUsd,
        })
      } catch (error) {
        if (error instanceof ConversationBudgetExceededError)
          throw new GuardrailBlockedError(
            "This agent has reached its daily usage budget."
          )
        throw error
      }
    }
    if (dependencies.checkBudget)
      await dependencies.checkBudget({
        context,
        agent,
        conversation,
        input: inputText,
      })

    trace = await traceStart(context, agent, conversation, turn, inputText)
    if (trace)
      await service.setTrace(
        turn.id,
        trace.trace.id,
        trace.session.id,
        turn.ownerFence
      )

    const appliedDefinitions =
      dependencies.resolveActions && dependencies.resolveProcedures
        ? null
        : await getRuntimeAppliedDefinitions(
            context as BuildContext,
            agent.id,
            agent.appliedRevision
          )
    const actions = dependencies.resolveActions
      ? await dependencies.resolveActions(context, agent)
      : (appliedDefinitions?.actions ?? [])
    const actionMap = new Map(
      actions
        .filter(
          (item) =>
            item.definition.enabled &&
            item.definition.channels.includes(parsed.channel)
        )
        .map((item) => [item.id, item])
    )
    const modelActionMap = new Map(
      [...actionMap].filter(([, item]) => !item.definition.procedureOnly)
    )
    const procedures = dependencies.resolveProcedures
      ? await dependencies.resolveProcedures(context, agent)
      : (appliedDefinitions?.procedures ?? [])
    assertRuntimeDefinitionScope(agent, actions, procedures)
    const runtimeSecretValues = [
      ...new Set(
        actions.flatMap((item) => actionSecretValues(item.definition))
      ),
    ]
    const finalizeProcedureResult = async (
      procedureResult: ProcedureResult,
      source: "procedure" | "procedure_resume" = "procedure"
    ): Promise<RunAgentTurnResult> => {
      const output = redactRuntimeText(
        procedureResult.text ||
          procedureResult.continuations
            .map((item) => item.message ?? "")
            .filter(Boolean)
            .join("\n"),
        runtimeSecretValues
      )
      const resultMessage =
        output || procedureResult.continuations.length
          ? await service.appendMessage(
              conversation.id,
              {
                role: "assistant",
                content:
                  output ||
                  continuationMessageContent(procedureResult.continuations),
                turnId: turn.id,
                status: "completed",
                metadata: {
                  source,
                  ...(source === "procedure_resume"
                    ? {
                        completedContinuationId:
                          widgetInteraction(parsed.metadata)?.continuationId ??
                          null,
                      }
                    : {}),
                  ...(await continuationMessageMetadata(
                    context,
                    conversation,
                    turn,
                    procedureResult.continuations
                  )),
                },
              },
              { ownerFence: turn.ownerFence }
            )
          : null
      if (budgetReservation) {
        await settleBudget(0, false)
        budgetReservation = null
      }
      const finalTurn = await service.finishTurn({
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        status: procedureResult.handoff
          ? "awaiting_client"
          : procedureResult.continuations.length
            ? "awaiting_client"
            : "completed",
        outputMessageId: resultMessage?.id,
        usage: {},
      })
      const finalConversation = procedureResult.handoff
        ? await service.claim(
            conversation.id,
            {
              type: "human",
              id:
                procedureResult.handoffOwnerId ??
                context.actorId ??
                `team:${agent.id}`,
              reason:
                source === "procedure_resume"
                  ? "Resumed procedure handoff"
                  : "Agent handoff action",
            },
            {
              expectedOwnerFence: turn.ownerFence,
              expectedOwnerType: "ai",
              handoffTurnId: turn.id,
            }
          )
        : await service.require(conversation.id)
      const toolCalls = await service.listToolCalls(conversation.id)
      await traceFinish(trace, output, "completed", {}, toolCalls)
      return {
        status: procedureResult.handoff
          ? "handed_off"
          : procedureResult.continuations.length
            ? "awaiting_client"
            : "completed",
        conversation: finalConversation,
        turn: finalTurn,
        message: resultMessage,
        text: output,
        continuations: procedureResult.continuations,
        toolCalls,
        traceId: finalTurn.traceId,
        usage: {},
        replayed: false,
      }
    }
    const catalogSnapshot = {
      ...turn.snapshot,
      actions: actions.map((item) => ({
        id: item.id,
        revision: item.revision,
      })),
      procedures: procedures.map((item) => ({
        id: item.id,
        revision: item.revision,
      })),
    }
    const snapshottedTurn = await service.setSnapshot(
      turn.id,
      catalogSnapshot,
      turn.ownerFence
    )
    turn.snapshot = snapshottedTurn.snapshot
    const interaction = widgetInteraction(parsed.metadata)
    if (interaction) {
      const isWaitInteraction = interaction.actionId === "__wait__"
      if (
        isWaitInteraction &&
        options.trustedWaitContinuationId !== interaction.continuationId
      )
        throw new BuildRuntimeError(
          "CONTINUATION_NOT_AVAILABLE",
          "This customer interaction is no longer available."
        )
      const allowApproval =
        options.trustedApproval?.actionId === interaction.actionId
      const claimed = await service.claimContinuation({
        conversationId: conversation.id,
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        actionId: interaction.actionId,
        widgetId: interaction.widgetId,
        continuationId: interaction.continuationId,
        allowApproval,
      })
      if (!claimed) {
        throw new BuildRuntimeError(
          "CONTINUATION_NOT_AVAILABLE",
          "This customer interaction is no longer available."
        )
      }
      const sourceRevision = Number(claimed.sourceSnapshot.agentRevision)
      let continuationActions = actions
      let continuationProcedures = procedures
      let continuationWidgets = appliedDefinitions?.widgets ?? []
      try {
        if (
          !dependencies.resolveActions &&
          Number.isInteger(sourceRevision) &&
          sourceRevision > 0
        ) {
          const pinned = await getRuntimeAppliedDefinitions(
            context as BuildContext,
            agent.id,
            sourceRevision
          )
          continuationActions = pinned.actions
          continuationProcedures = pinned.procedures
          continuationWidgets = pinned.widgets
        }
      } catch (error) {
        await service.recordToolCallFinish({
          conversationId: conversation.id,
          turnId: turn.id,
          toolCallId: claimed.call.toolCallId,
          status: "failed",
          error: safeError(error),
          ownerFence: turn.ownerFence,
        })
        throw error
      }
      const continuationActionMap = new Map(
        continuationActions
          .filter(
            (item) =>
              item.definition.enabled &&
              item.definition.channels.includes(parsed.channel)
          )
          .map((item) => [item.id, item] as const)
      )
      const continuationCursor = parseProcedureCursor(
        claimed.call.continuation?.procedureCursor
      )
      if (isWaitInteraction) {
        const resumeAt = claimed.call.continuation?.resumeAt
        if (
          typeof resumeAt === "string" &&
          Number.isFinite(Date.parse(resumeAt)) &&
          Date.parse(resumeAt) > Date.now()
        ) {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "awaiting_client",
            output: claimed.call.output,
            continuation: claimed.call.continuation,
            ownerFence: turn.ownerFence,
          })
          throw new BuildRuntimeError(
            "CONTINUATION_NOT_AVAILABLE",
            "This wait period has not elapsed yet."
          )
        }
        const resumeCursor = continuationCursor
        if (!resumeCursor) {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: {
              kind: "PROCEDURE_NOT_FOUND",
              message: "The paused procedure is no longer available.",
            },
            ownerFence: turn.ownerFence,
          })
          throw new BuildRuntimeError(
            "PROCEDURE_NOT_FOUND",
            "The paused procedure is no longer available."
          )
        }
        try {
          const procedureResult = await runProcedure(
            context,
            service,
            conversation,
            turn,
            inputText,
            continuationProcedures,
            continuationActionMap,
            dependencies,
            configuration.guardrails.requireHumanForActions,
            options.signal,
            {},
            undefined,
            undefined,
            resumeCursor
          )
          if (!procedureResult) {
            await service.recordToolCallFinish({
              conversationId: conversation.id,
              turnId: turn.id,
              toolCallId: claimed.call.toolCallId,
              status: "failed",
              error: {
                kind: "PROCEDURE_NOT_FOUND",
                message: "The paused procedure is no longer available.",
              },
              ownerFence: turn.ownerFence,
            })
            throw new BuildRuntimeError(
              "PROCEDURE_NOT_FOUND",
              "The paused procedure is no longer available."
            )
          }
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "completed",
            output:
              procedureResult.text ||
              (procedureResult.continuations.length
                ? continuationMessageContent(procedureResult.continuations)
                : null),
            continuation: procedureResult.continuations[0] ?? null,
            ownerFence: turn.ownerFence,
          })
          return finalizeProcedureResult(procedureResult, "procedure_resume")
        } catch (error) {
          if (
            error instanceof BuildRuntimeError &&
            error.code === "PROCEDURE_NOT_FOUND"
          )
            throw error
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: safeError(error),
            ownerFence: turn.ownerFence,
          })
          throw error
        }
      }
      const persistedContinuation = claimed.call.continuation ?? {}
      const continuationType = persistedContinuation?.type
      // A widget can open another action while retaining the original tool
      // call. Resume the action named by the current persisted continuation.
      const continuationActionId =
        typeof persistedContinuation.actionId === "string"
          ? persistedContinuation.actionId
          : claimed.call.actionId
      const persistedSubmitActionId =
        continuationType === "form" &&
        typeof persistedContinuation.submitActionId === "string" &&
        persistedContinuation.submitActionId.trim()
          ? persistedContinuation.submitActionId.trim()
          : null
      const isFormSubmission = continuationType === "form"
      const isStandaloneFormSubmission =
        isFormSubmission &&
        !persistedSubmitActionId &&
        interaction.actionId === continuationActionId
      if (
        isFormSubmission &&
        !isStandaloneFormSubmission &&
        interaction.actionId !== persistedSubmitActionId
      ) {
        await service.recordToolCallFinish({
          conversationId: conversation.id,
          turnId: turn.id,
          toolCallId: claimed.call.toolCallId,
          status: "failed",
          error: {
            kind: "ACTION_NOT_FOUND",
            message: "The submitted form target is no longer available.",
          },
          ownerFence: turn.ownerFence,
        })
        throw new BuildRuntimeError(
          "ACTION_NOT_FOUND",
          "This customer interaction is no longer available."
        )
      }
      const isWidgetChildInteraction =
        continuationType === "widget" &&
        interaction.actionId !== continuationActionId
      if (isWidgetChildInteraction) {
        const widgetId =
          typeof persistedContinuation?.widgetId === "string"
            ? persistedContinuation.widgetId
            : null
        const widget = continuationWidgets.find(
          (item) => item.id === widgetId && item.definition.enabled
        )
        const allowed = widget?.definition.code
          ? widget.definition.functions.some(
              (fn) => fn.actionId === interaction.actionId
            )
          : widget?.definition.components.some((component) =>
              component.type === "button"
                ? component.actionId === interaction.actionId
                : component.type === "form"
                  ? component.submitActionId === interaction.actionId
                  : component.type === "card" &&
                    component.actionId === interaction.actionId
            )
        if (!allowed) {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: {
              kind: "ACTION_NOT_FOUND",
              message: "The submitted widget action is no longer available.",
            },
            ownerFence: turn.ownerFence,
          })
          throw new BuildRuntimeError(
            "ACTION_NOT_FOUND",
            "This customer interaction is no longer available."
          )
        }
      }
      const resolvedActionId =
        isFormSubmission || isWidgetChildInteraction
          ? interaction.actionId
          : continuationActionId
      const action = continuationActions.find(
        (item) =>
          item.id === resolvedActionId &&
          item.definition.enabled &&
          item.definition.channels.includes(parsed.channel)
      )
      if (!action) {
        await service.recordToolCallFinish({
          conversationId: conversation.id,
          turnId: turn.id,
          toolCallId: claimed.call.toolCallId,
          status: "failed",
          error: {
            kind: "ACTION_NOT_FOUND",
            message: "The action is no longer available.",
          },
          ownerFence: turn.ownerFence,
        })
        throw new BuildRuntimeError(
          "ACTION_NOT_FOUND",
          "This customer interaction is no longer available."
        )
      }
      if (isFormSubmission) {
        const formAction = continuationActions.find(
          (item) =>
            item.id === continuationActionId &&
            item.definition.enabled &&
            item.definition.channels.includes(parsed.channel)
        )
        if (!formAction || formAction.definition.type !== "form") {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: {
              kind: "ACTION_NOT_FOUND",
              message: "The form is no longer available.",
            },
            ownerFence: turn.ownerFence,
          })
          throw new BuildRuntimeError(
            "ACTION_NOT_FOUND",
            "This customer interaction is no longer available."
          )
        }
        const pinnedSubmitActionId =
          formAction.definition.submitActionId?.trim() || null
        if (pinnedSubmitActionId !== persistedSubmitActionId) {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: {
              kind: "ACTION_NOT_FOUND",
              message: "The submitted form target is no longer available.",
            },
            ownerFence: turn.ownerFence,
          })
          throw new BuildRuntimeError(
            "ACTION_NOT_FOUND",
            "This customer interaction is no longer available."
          )
        }
        try {
          validateFormSubmission(formAction.definition, interaction.input)
        } catch (error) {
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "failed",
            error: safeError(error),
            ownerFence: turn.ownerFence,
          })
          throw error
        }
      }
      if (Number.isInteger(sourceRevision) && sourceRevision > 0) {
        const pinnedSnapshot = await service.setSnapshot(
          turn.id,
          {
            ...turn.snapshot,
            agentRevision: sourceRevision,
            actions: Array.isArray(claimed.sourceSnapshot.actions)
              ? claimed.sourceSnapshot.actions
              : continuationActions.map((item) => ({
                  id: item.id,
                  revision: item.revision,
                })),
            procedures: Array.isArray(claimed.sourceSnapshot.procedures)
              ? claimed.sourceSnapshot.procedures
              : procedures.map((item) => ({
                  id: item.id,
                  revision: item.revision,
                })),
          },
          turn.ownerFence,
          { preserveAgentRevision: false }
        )
        turn.snapshot = pinnedSnapshot.snapshot
      }
      if (isStandaloneFormSubmission && action.definition.type === "form") {
        try {
          let contactId =
            typeof conversation.metadata.contactId === "string" &&
            conversation.metadata.contactId.trim()
              ? conversation.metadata.contactId.trim()
              : undefined
          const form = action.definition
          await (context as BuildContext).database.transaction(async (tx) => {
            const formContext = {
              ...context,
              database: tx,
            } as unknown as BuildContext
            if (form.captureLead) {
              const owner = await tx.execute(sql`
                select id from build_conversations
                where project_id=${context.projectId} and id=${conversation.id}
                  and owner_fence=${turn.ownerFence}
                for update
              `)
              if (!owner.rows.length)
                throw new ConversationOwnershipLostError(conversation.id)
              const values = interaction.input
              const details = {
                ...(typeof values.name === "string"
                  ? { displayName: values.name }
                  : {}),
                ...(typeof values.email === "string"
                  ? { email: values.email }
                  : {}),
                ...(typeof values.phone === "string"
                  ? { phone: values.phone }
                  : {}),
              }
              const contact = contactId
                ? await updateContact(formContext, contactId, details)
                : await createContact(formContext, {
                    externalId: `form:${conversation.id}`,
                    ...details,
                  })
              contactId = contact.id
              await tx.execute(sql`
                update build_conversations
                set metadata_json=metadata_json || ${JSON.stringify({ contactId })}::jsonb
                where project_id=${context.projectId} and id=${conversation.id}
              `)
            }
            for (const [fieldKey, value] of Object.entries(interaction.input))
              await collectData(formContext, {
                contactId,
                conversationId: conversation.id,
                fieldKey,
                value,
                source: "form",
              })
            if (form.captureLead)
              await upsertLead(formContext, {
                id: `lead_${createHash("sha256").update(`${conversation.id}:${interaction.continuationId}`).digest("hex")}`,
                contactId,
                conversationId: conversation.id,
                source: "form",
                data: interaction.input,
              })
          })
          const output = "Form submitted."
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "completed",
            output: {
              submitted: persistedRuntimeRecord(interaction.input),
            },
            ownerFence: turn.ownerFence,
          })
          if (continuationCursor) {
            const procedureResult = await runProcedure(
              context,
              service,
              conversation,
              turn,
              inputText,
              continuationProcedures,
              continuationActionMap,
              dependencies,
              configuration.guardrails.requireHumanForActions,
              options.signal,
              {},
              undefined,
              undefined,
              continuationCursor
            )
            if (!procedureResult)
              throw new BuildRuntimeError(
                "PROCEDURE_NOT_FOUND",
                "The paused procedure is no longer available."
              )
            return finalizeProcedureResult(
              {
                ...procedureResult,
                text: [output, procedureResult.text]
                  .filter(Boolean)
                  .join("\n\n"),
              },
              "procedure_resume"
            )
          }
          const resultMessage = await service.appendMessage(
            conversation.id,
            {
              role: "assistant",
              content: output,
              turnId: turn.id,
              status: "completed",
              metadata: {
                source: "widget_interaction",
                completedContinuationId: interaction.continuationId ?? null,
                actionId: interaction.actionId,
                widgetId: interaction.widgetId ?? null,
              },
            },
            { ownerFence: turn.ownerFence }
          )
          if (budgetReservation) {
            await settleBudget(0, false)
            budgetReservation = null
          }
          const finalTurn = await service.finishTurn({
            turnId: turn.id,
            ownerFence: turn.ownerFence,
            status: "completed",
            outputMessageId: resultMessage.id,
            usage: {},
          })
          const finalConversation = await service.require(conversation.id)
          const toolCalls = await service.listToolCalls(conversation.id)
          await traceFinish(trace, output, "completed", {}, toolCalls)
          return {
            status: "completed",
            conversation: finalConversation,
            turn: finalTurn,
            message: resultMessage,
            text: output,
            continuations: [],
            toolCalls,
            traceId: finalTurn.traceId,
            usage: {},
            replayed: false,
          }
        } catch (error) {
          if (
            !(error instanceof ConversationOwnershipLostError) &&
            !(
              error instanceof BuildRuntimeError &&
              error.code === "PROCEDURE_NOT_FOUND"
            )
          )
            await service.recordToolCallFinish({
              conversationId: conversation.id,
              turnId: turn.id,
              toolCallId: claimed.call.toolCallId,
              status: "failed",
              error: safeError(error),
              ownerFence: turn.ownerFence,
            })
          throw error
        }
      }
      const resumesClientProcedure =
        continuationType === "client_action" &&
        action.definition.type === "client" &&
        Boolean(continuationCursor) &&
        interaction.actionId === continuationActionId
      if (
        resumesClientProcedure &&
        action.definition.type === "client" &&
        continuationCursor
      ) {
        try {
          if (Object.keys(action.definition.resultSchema).length)
            validateSchema(action.definition.resultSchema, interaction.input)
          await service.recordToolCallFinish({
            conversationId: conversation.id,
            turnId: turn.id,
            toolCallId: claimed.call.toolCallId,
            status: "completed",
            output: persistedRuntimeRecord(interaction.input),
            ownerFence: turn.ownerFence,
          })
          const procedureResult = await runProcedure(
            context,
            service,
            conversation,
            turn,
            inputText,
            continuationProcedures,
            continuationActionMap,
            dependencies,
            configuration.guardrails.requireHumanForActions,
            options.signal,
            {},
            undefined,
            undefined,
            continuationCursor
          )
          if (!procedureResult)
            throw new BuildRuntimeError(
              "PROCEDURE_NOT_FOUND",
              "The paused procedure is no longer available."
            )
          return finalizeProcedureResult(procedureResult, "procedure_resume")
        } catch (error) {
          if (
            !(error instanceof ConversationOwnershipLostError) &&
            !(
              error instanceof BuildRuntimeError &&
              error.code === "PROCEDURE_NOT_FOUND"
            )
          )
            await service.recordToolCallFinish({
              conversationId: conversation.id,
              turnId: turn.id,
              toolCallId: claimed.call.toolCallId,
              status: "failed",
              error: safeError(error),
              ownerFence: turn.ownerFence,
            })
          throw error
        }
      }
      const approvalAllowed =
        allowApproval &&
        options.trustedApproval?.actionId === continuationActionId &&
        (!options.trustedApproval.continuationId ||
          options.trustedApproval.continuationId ===
            (typeof claimed.call.continuation?.continuationId === "string"
              ? claimed.call.continuation.continuationId
              : undefined))
      const approvedInput =
        approvalAllowed &&
        claimed.call.continuation &&
        typeof claimed.call.continuation.input === "object" &&
        !Array.isArray(claimed.call.continuation.input)
          ? (claimed.call.continuation.input as Record<string, unknown>)
          : interaction.input
      const result = await executeAction(
        context,
        service,
        conversation,
        turn,
        action.definition,
        approvedInput,
        {
          dependencies,
          toolCallId: claimed.call.toolCallId,
          question: inputText,
          requireHumanForActions:
            configuration.guardrails.requireHumanForActions,
          allowApproval: approvalAllowed,
          procedureCursor: continuationCursor ?? undefined,
          signal: options.signal,
        }
      )
      if (continuationCursor && !result.continuation) {
        const procedureResult = await runProcedure(
          context,
          service,
          conversation,
          turn,
          inputText,
          continuationProcedures,
          continuationActionMap,
          dependencies,
          configuration.guardrails.requireHumanForActions,
          options.signal,
          {},
          undefined,
          undefined,
          continuationCursor
        )
        if (!procedureResult)
          throw new BuildRuntimeError(
            "PROCEDURE_NOT_FOUND",
            "The paused procedure is no longer available."
          )
        const actionText = actionOutputText(result.output)
        return finalizeProcedureResult(
          actionText
            ? {
                ...procedureResult,
                text: [actionText, procedureResult.text]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : procedureResult,
          "procedure_resume"
        )
      }
      const continuations = result.continuation ? [result.continuation] : []
      const output = redactRuntimeText(
        actionOutputText(result.output) ||
          continuations
            .map((item) => item.message ?? "")
            .filter(Boolean)
            .join("\n"),
        runtimeSecretValues
      )
      const resultMessage =
        output || continuations.length
          ? await service.appendMessage(
              conversation.id,
              {
                role: "assistant",
                content: output || continuationMessageContent(continuations),
                turnId: turn.id,
                status: "completed",
                metadata: {
                  source: "widget_interaction",
                  completedContinuationId: interaction.continuationId ?? null,
                  actionId: interaction.actionId,
                  widgetId: interaction.widgetId ?? null,
                  ...(await continuationMessageMetadata(
                    context,
                    conversation,
                    turn,
                    continuations
                  )),
                },
              },
              { ownerFence: turn.ownerFence }
            )
          : null
      if (budgetReservation) {
        await settleBudget(0, false)
        budgetReservation = null
      }
      const handedOff = continuations.some((item) => item.type === "handoff")
      const finalTurn = await service.finishTurn({
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        status:
          handedOff || continuations.length ? "awaiting_client" : "completed",
        outputMessageId: resultMessage?.id,
        usage: {},
      })
      const finalConversation = handedOff
        ? await service.claim(
            conversation.id,
            {
              type: "human",
              id:
                continuations.find((item) => item.type === "handoff")?.teamId ??
                context.actorId ??
                `team:${agent.id}`,
              reason: "Widget interaction handoff",
            },
            {
              expectedOwnerFence: turn.ownerFence,
              expectedOwnerType: "ai",
              handoffTurnId: turn.id,
            }
          )
        : await service.require(conversation.id)
      const toolCalls = await service.listToolCalls(conversation.id)
      await traceFinish(trace, output, "completed", {}, toolCalls)
      return {
        status: handedOff
          ? "handed_off"
          : continuations.length
            ? "awaiting_client"
            : "completed",
        conversation: finalConversation,
        turn: finalTurn,
        message: resultMessage,
        text: output,
        continuations,
        toolCalls,
        traceId: finalTurn.traceId,
        usage: {},
        replayed: false,
      }
    }
    const procedureResult = await runProcedure(
      context,
      service,
      conversation,
      turn,
      inputText,
      procedures,
      actionMap,
      dependencies,
      configuration.guardrails.requireHumanForActions,
      options.signal,
      options.trustedMetadata ?? {},
      options.requiredProcedureId
    )
    if (options.requiredProcedureId && !procedureResult)
      throw new BuildRuntimeError(
        "PROCEDURE_NOT_FOUND",
        "The requested manual procedure is not available on this applied agent revision."
      )
    if (procedureResult?.stopped) {
      return finalizeProcedureResult(procedureResult)
    }

    let knowledge: RuntimeKnowledgeResult | null = null
    if (dependencies.retrieveKnowledge) {
      knowledge = await dependencies.retrieveKnowledge({
        context,
        agent,
        conversation,
        query: inputText,
        signal: options.signal,
      })
    } else {
      // Customer runtime uses the indexed, tenant-scoped retrieval service by
      // default. It is deterministic FTS/literal/prefix retrieval; model
      // query expansion remains an explicit dependency so a live turn never
      // incurs an unbudgeted second model call.
      try {
        const grounded = await retrieveGroundedKnowledge(context, {
          agentId: agent.id,
          query: inputText,
          limit: 8,
        })
        knowledge = {
          text: grounded.text,
          documents: grounded.documents,
          snapshotId: grounded.snapshotId,
        }
      } catch {
        // An unavailable or empty knowledge index must not fabricate context
        // or prevent the configured agent model from answering generally.
        knowledge = null
      }
    }
    if (knowledge?.snapshotId) {
      const snapshot = await service.setSnapshot(
        turn.id,
        {
          ...turn.snapshot,
          knowledgeSnapshotId: knowledge.snapshotId,
          knowledgeDocuments: persistedRuntimeValue(knowledge.documents ?? []),
        },
        turn.ownerFence
      )
      turn.snapshot = snapshot.snapshot
    }
    const system = [
      configuration.instructions,
      knowledge?.text ? `Knowledge context:\n${knowledge.text}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    const modelMessages = (await service.getMessagesForModel(conversation.id))
      .filter(
        (message) => message.role === "user" || message.role === "assistant"
      )
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: textFromContent(message.content),
      }))
    let pendingModelUsage: string | null = null
    // AI SDK event callbacks report and swallow errors. Keep admission and
    // side effects blocked if a model usage report could not be persisted.
    function assertModelUsageRecorded() {
      if (pendingModelUsage)
        throw new BuildRuntimeError(
          "MODEL_USAGE_UNAVAILABLE",
          "The previous model call's usage is not yet recorded."
        )
    }
    const aiTools: Record<string, unknown> = {}
    const continuations: RuntimeContinuation[] = []
    const invokedIntentProcedures = new Set<string>()
    for (const action of modelActionMap.values()) {
      const actionDefinition = action.definition
      aiTools[action.id] = tool({
        description: actionDefinition.description || actionDefinition.name,
        inputSchema: jsonSchema<Record<string, unknown>>(
          actionDefinition.inputSchema as Record<string, unknown>
        ),
        execute: async (
          args: Record<string, unknown>,
          toolOptions: { toolCallId?: string }
        ) => {
          assertModelUsageRecorded()
          const toolCallId = toolOptions.toolCallId ?? randomUUID()
          const result = await executeAction(
            context,
            service,
            conversation,
            turn,
            actionDefinition,
            args,
            {
              dependencies,
              toolCallId,
              question: inputText,
              requireHumanForActions:
                configuration.guardrails.requireHumanForActions,
              signal: options.signal,
            }
          )
          if (result.continuation) {
            continuations.push(result.continuation)
            if (result.continuation.type === "handoff") {
              handoffRequested = true
              handoffOwnerId =
                result.continuation.teamId ??
                context.actorId ??
                `team:${actionDefinition.id}`
            }
          }
          return result.output
        },
      } as never)
    }
    for (const procedure of procedures) {
      if (
        !procedure.definition.enabled ||
        procedure.definition.trigger.type !== "intent"
      )
        continue
      const procedureToolName = `procedure_${procedure.id}`
      aiTools[procedureToolName] = tool({
        description:
          procedure.definition.description ||
          `Run the intent procedure ${procedure.definition.name} for customer requests matching the configured intent '${procedure.definition.trigger.value}'.`,
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => {
          assertModelUsageRecorded()
          if (invokedIntentProcedures.has(procedure.id))
            return {
              error: "This intent procedure already ran in this turn.",
            }
          invokedIntentProcedures.add(procedure.id)
          const procedureResult = await runProcedure(
            context,
            service,
            conversation,
            turn,
            inputText,
            procedures,
            actionMap,
            dependencies,
            configuration.guardrails.requireHumanForActions,
            options.signal,
            {},
            undefined,
            procedure.id
          )
          if (!procedureResult)
            throw new BuildRuntimeError(
              "PROCEDURE_NOT_FOUND",
              "The requested intent procedure is no longer available."
            )
          continuations.push(...procedureResult.continuations)
          if (procedureResult.handoff) {
            handoffRequested = true
            handoffOwnerId = procedureResult.handoffOwnerId
          }
          return {
            text: procedureResult.text,
            continuations: procedureResult.continuations,
          }
        },
      } as never)
    }
    if (!configuration.model.trim())
      throw new BuildRuntimeError(
        "MODEL_NOT_CONFIGURED",
        "Configure a model for this agent before running it."
      )
    let result: Awaited<ReturnType<typeof generateText>>
    try {
      const generate = dependencies.generateText ?? generateText
      const selection = runtimeProviderSelection(configuration)
      const providerKey = dependencies.generateText
        ? undefined
        : await getProjectProviderKey(
            context.projectId,
            selection.provider,
            context.database
          )
      if (providerKey) runtimeSecretValues.push(providerKey)
      const model = dependencies.generateText
        ? selection.modelId
        : selection.provider === OPENAI_PROVIDER
          ? createOpenAI({
              apiKey: providerKey,
              fetch: dependencies.fetch,
            }).chat(selection.modelId)
          : createGateway({
              apiKey: providerKey,
              fetch: dependencies.fetch,
            }).languageModel(selection.modelId)
      const telemetry = trace
        ? createAiTelemetry({
            service: trace.service,
            traceId: trace.trace.id,
            signal: options.signal,
            transform: (payload) =>
              redactTracePayload(payload, runtimeSecretValues),
          })
        : null
      modelExecutionStarted = true
      try {
        result = await generate({
          model,
          system,
          messages: modelMessages,
          tools: aiTools,
          stopWhen: isStepCount(
            Math.max(1, Math.min(options.maxToolSteps ?? 8, 20))
          ),
          maxRetries: 0,
          prepareStep: async () => {
            assertModelUsageRecorded()
            pendingModelUsage = await beginModelUsage(context, {
              agentId: agent.id,
              conversationId: conversation.id,
              turnId: turn.id,
              provider: selection.provider,
              model: selection.modelId,
            })
            return undefined
          },
          onLanguageModelCallEnd: async (event: LanguageModelCallEndEvent) => {
            if (pendingModelUsage) {
              await finishModelUsage(
                context,
                pendingModelUsage,
                event.usage,
                event.providerMetadata,
                event.responseId
              )
              pendingModelUsage = null
            }
          },
          temperature: configuration.temperature,
          maxOutputTokens: configuration.guardrails.maxOutputTokens,
          abortSignal: options.signal,
          telemetry: telemetry
            ? {
                isEnabled: true,
                recordInputs: true,
                recordOutputs: true,
                integrations: [telemetry.integration],
              }
            : undefined,
        } as never)
      } finally {
        if (pendingModelUsage)
          await finishModelUsage(context, pendingModelUsage).catch(
            () => undefined
          )
        await telemetry?.shutdown().catch(() => {
          // Delivery failure must not erase the durable customer turn.
          if (trace)
            trace.trace.attributes["telemetry.delivery.status"] = "failed"
        })
      }
    } catch (error) {
      if (options.signal?.aborted)
        throw new BuildRuntimeError("TURN_CANCELLED", "The turn was cancelled.")
      if (error instanceof BuildRuntimeError) throw error
      // Do not retain or return provider error payloads: they can contain
      // authorization headers, request bodies or upstream customer data.
      throw new BuildRuntimeError(
        "MODEL_REQUEST_FAILED",
        "The agent model request failed."
      )
    }
    const text = redactRuntimeText(
      result.text ||
        continuations
          .map((item) => item.message ?? "")
          .filter(Boolean)
          .join("\n"),
      runtimeSecretValues
    )
    const resultMessage =
      text || continuations.length
        ? await service.appendMessage(
            conversation.id,
            {
              role: "assistant",
              content: text || continuationMessageContent(continuations),
              turnId: turn.id,
              status: "completed",
              metadata: {
                model: runtimeProviderSelection(configuration).modelId,
                provider: runtimeProviderSelection(configuration).provider,
                revision: agent.appliedRevision || agent.currentRevision,
                ...(await continuationMessageMetadata(
                  context,
                  conversation,
                  turn,
                  continuations
                )),
              },
            },
            { ownerFence: turn.ownerFence }
          )
        : null
    const usage = usageObject(result.totalUsage ?? result.usage)
    const actualCostUsd = usageCostUsd(result)
    if (actualCostUsd !== null) usage.costUsd = actualCostUsd
    const budgetReservationId = budgetReservation?.reservationId
    if (budgetReservation) {
      await settleBudget(actualCostUsd, false)
      budgetReservation = null
    }
    if (
      budgetReservationId &&
      (usage.costUsd === undefined || usage.costUsd === null)
    )
      usage.budgetReservationId = budgetReservationId
    const finalTurn = await service.finishTurn({
      turnId: turn.id,
      ownerFence: turn.ownerFence,
      status:
        continuations.some((item) => item.type === "handoff") ||
        continuations.length
          ? "awaiting_client"
          : "completed",
      outputMessageId: resultMessage?.id,
      usage,
    })
    const finalConversation = handoffRequested
      ? await service.claim(
          conversation.id,
          {
            type: "human",
            id: handoffOwnerId ?? context.actorId ?? `team:${agent.id}`,
            reason: "Agent handoff action",
          },
          {
            expectedOwnerFence: turn.ownerFence,
            expectedOwnerType: "ai",
            handoffTurnId: turn.id,
          }
        )
      : await service.require(conversation.id)
    const toolCalls = await service.listToolCalls(conversation.id)
    await traceFinish(trace, text, "completed", usage, toolCalls)
    return {
      status: continuations.some((item) => item.type === "handoff")
        ? "handed_off"
        : continuations.length
          ? "awaiting_client"
          : "completed",
      conversation: finalConversation,
      turn: finalTurn,
      message: resultMessage,
      text,
      continuations,
      toolCalls,
      traceId: finalTurn.traceId,
      usage,
      replayed: false,
    }
  } catch (error) {
    const safe = safeError(error)
    if (budgetReservation)
      await settleBudget(null, modelExecutionStarted ? false : true).catch(
        () => undefined
      )
    if (error instanceof ConversationOwnershipLostError) {
      await service.markUncertain(turn.id, safe, turn.ownerFence)
      throw error
    }
    if (error instanceof GuardrailBlockedError) {
      const message = await service.appendMessage(
        conversation.id,
        {
          role: "assistant",
          content: error.message,
          turnId: turn.id,
          status: "completed",
          metadata: { guardrail: error.code },
        },
        { ownerFence: turn.ownerFence }
      )
      const finalTurn = await service.finishTurn({
        turnId: turn.id,
        ownerFence: turn.ownerFence,
        status: "completed",
        outputMessageId: message.id,
        usage: {},
        error: safe,
      })
      await traceFinish(trace, error.message, "completed", {}, [])
      return {
        status: "blocked",
        conversation: await service.require(conversation.id),
        turn: finalTurn,
        message,
        text: error.message,
        continuations: [],
        toolCalls: [],
        traceId: finalTurn.traceId,
        usage: {},
        replayed: false,
      }
    }
    await recordRuntimeFailureEvent(context, {
      eventType: "agent_failed",
      key: turn.id,
      conversation,
      question: inputText,
      payload: {
        turnId: turn.id,
        error: safe,
      },
    }).catch(() => undefined)
    const uncertain =
      error instanceof BuildRuntimeError && error.code === "ACTION_UNCERTAIN"
    if (uncertain) await service.markUncertain(turn.id, safe, turn.ownerFence)
    else {
      try {
        await service.finishTurn({
          turnId: turn.id,
          ownerFence: turn.ownerFence,
          status: options.signal?.aborted ? "cancelled" : "failed",
          usage: {},
          error: safe,
        })
      } catch {
        await service.markUncertain(turn.id, safe, turn.ownerFence)
      }
    }
    const failedToolCalls = await service
      .listToolCalls(conversation.id)
      .catch(() => modelToolCalls)
    await traceFinish(
      trace,
      "",
      options.signal?.aborted ? "cancelled" : "errored",
      {},
      failedToolCalls
    )
    throw error
  }
}

export { ConversationBusyError, ConversationHumanOwnedError }

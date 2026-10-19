import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI } from "@ai-sdk/openai"
import { generateObject, generateText, type LanguageModel } from "ai"
import { z } from "zod"

import {
  actionDefinitionSchema,
  agentConfigurationSchema,
  procedureDefinitionSchema,
  type ActionRecord,
  type ProcedureRecord,
} from "@/src/lib/build/contracts"
import {
  observedActionSchema,
  simulationMessageSchema,
  simulationVerdictSchema,
  type ObservedAction,
  type SimulationDefinitionRecord,
  type SimulationMessage,
  type SimulationVerdict,
} from "@/src/lib/build/testing"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  type ModelProvider,
} from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import type { BuildContext } from "../context"
import { ConversationService } from "../conversations"
import type {
  ConversationMessage,
  ConversationToolCall,
} from "../conversation-schema"
import {
  BuildRuntimeError,
  runAgentTurn,
  type RuntimeActionExecutionResult,
  type RuntimeAgent,
  type RuntimeDependencies,
} from "../runtime"
import type { SimulationExecutor, SimulationExecutorInput } from "./service"

/** Structured response emitted by the simulated customer model. */
const customerResponseSchema = z.object({
  message: z.string().max(8_000),
  done: z.boolean(),
})

/** Structured response emitted by the judge model. */
const judgeResponseSchema = z.object({
  status: z.enum(["passed", "failed", "no_verdict"]),
  // Keep every property required for OpenAI strict structured outputs. Zod
  // defaults become optional JSON Schema properties, which OpenAI rejects for
  // response_format=json_schema in strict mode.
  reason: z.string().max(8_000),
  criteria: z
    .array(
      z.object({
        criterion: z.string().max(2_000),
        passed: z.boolean().nullable(),
        reason: z.string().max(4_000),
      })
    )
    .max(50),
  score: z.number().min(0).max(1).nullable(),
})

type CustomerResponse = z.infer<typeof customerResponseSchema>

export type RuntimeSimulationCustomerInput = {
  definition: SimulationDefinitionRecord
  testCase: SimulationExecutorInput["testCase"]
  transcript: SimulationMessage[]
  model: string
  provider: ModelProvider
  signal: AbortSignal
}

export type RuntimeSimulationJudgeInput = {
  definition: SimulationDefinitionRecord
  testCase: SimulationExecutorInput["testCase"]
  transcript: SimulationMessage[]
  observedActions: SimulationExecutorInput["testCase"]["observedActions"]
  model: string
  provider: ModelProvider
  signal: AbortSignal
}

export type RuntimeSimulationExecutorOptions = {
  /** Injected model functions are intended for deterministic contract tests. */
  generateText?: typeof generateText
  generateObject?: typeof generateObject
  fetch?: typeof fetch
  resolveModel?: (
    context: BuildContext,
    model: string
  ) => Promise<LanguageModel>
  /** Null deliberately disables the customer simulator for a one-turn test. */
  customer?:
    | ((
        input: RuntimeSimulationCustomerInput
      ) => Promise<CustomerResponse | null>)
    | null
  /** Null deliberately records no_verdict; provider/model errors are infra_error. */
  judge?:
    | ((
        input: RuntimeSimulationJudgeInput
      ) => Promise<SimulationVerdict | null>)
    | null
  maxToolSteps?: number
}

function normalizeModel(model: string, provider: ModelProvider) {
  const prefix = `${provider}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return String(value)
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const item = part as Record<string, unknown>
          return typeof item.text === "string"
            ? item.text
            : JSON.stringify(part)
        })
        .filter(Boolean)
        .join(" ")
    }
    return JSON.stringify(value)
  }
  return String(value ?? "")
}

function snapshotRecords<T>(
  values: readonly JsonValue[],
  parseDefinition: (value: unknown) => T,
  context: BuildContext,
  agentId: string
) {
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Simulation snapshot record ${index} is invalid.`)
    const record = value as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id : ""
    if (!id) throw new Error(`Simulation snapshot record ${index} has no id.`)
    return {
      id,
      projectId: context.projectId,
      agentId,
      slug: typeof record.slug === "string" ? record.slug : id,
      revision:
        typeof record.revision === "number" && Number.isInteger(record.revision)
          ? record.revision
          : 1,
      definition: parseDefinition(record.definition),
      createdAt:
        typeof record.createdAt === "string"
          ? record.createdAt
          : new Date(0).toISOString(),
      updatedAt:
        typeof record.updatedAt === "string"
          ? record.updatedAt
          : new Date(0).toISOString(),
    }
  })
}

function snapshotActions(
  input: SimulationExecutorInput,
  context: BuildContext
): ActionRecord[] {
  return snapshotRecords(
    input.configSnapshot.actions,
    (value) => actionDefinitionSchema.parse(value),
    context,
    input.definition.agentId
  ) as unknown as ActionRecord[]
}

function snapshotProcedures(
  input: SimulationExecutorInput,
  context: BuildContext
): ProcedureRecord[] {
  return snapshotRecords(
    input.configSnapshot.procedures,
    (value) => procedureDefinitionSchema.parse(value),
    context,
    input.definition.agentId
  ) as unknown as ProcedureRecord[]
}

function knowledgeText(
  value: JsonValue,
  query: string
): { text: string; documents: Array<Record<string, unknown>> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const chunks = Array.isArray(source.chunks) ? source.chunks : []
  const sourceText =
    typeof source.contentText === "string" ? source.contentText : ""
  const records = chunks.flatMap((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return []
    const item = chunk as Record<string, unknown>
    return typeof item.content === "string"
      ? [
          {
            id: typeof item.id === "string" ? item.id : "chunk",
            content: item.content,
            metadata: item.metadata,
          },
        ]
      : []
  })
  if (sourceText && records.length === 0)
    records.push({ id: "source", content: sourceText, metadata: {} })
  if (records.length === 0) return null
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((term) => term.length > 2)
  const ranked = records
    .map((record, index) => ({
      record,
      index,
      score: terms.reduce(
        (total, term) =>
          total + (record.content.toLocaleLowerCase().includes(term) ? 1 : 0),
        0
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8)
  const text = ranked
    .map((entry) => entry.record.content)
    .join("\n\n")
    .slice(0, 16_000)
  return {
    text,
    documents: ranked.map((entry) => ({
      id: entry.record.id,
      content: entry.record.content,
      metadata: entry.record.metadata ?? {},
      score: entry.score,
    })),
  }
}

async function modelFor(
  context: BuildContext,
  model: string,
  provider: ModelProvider,
  options: RuntimeSimulationExecutorOptions
) {
  if (options.resolveModel) return options.resolveModel(context, model)
  const selectedProvider =
    provider === OPENAI_PROVIDER ? OPENAI_PROVIDER : GATEWAY_PROVIDER
  const apiKey = await getProjectProviderKey(
    context.projectId,
    selectedProvider,
    context.database
  )
  return selectedProvider === OPENAI_PROVIDER
    ? createOpenAI({ apiKey, fetch: options.fetch }).chat(
        normalizeModel(model, selectedProvider)
      )
    : createGateway({ apiKey, fetch: options.fetch }).languageModel(
        normalizeModel(model, selectedProvider)
      )
}

function modelName(input: SimulationExecutorInput) {
  const config =
    input.configSnapshot.config &&
    typeof input.configSnapshot.config === "object" &&
    !Array.isArray(input.configSnapshot.config)
      ? (input.configSnapshot.config as Record<string, unknown>)
      : {}
  const configured = typeof config.model === "string" ? config.model.trim() : ""
  return input.testCase.model === "default" || !input.testCase.model.trim()
    ? configured
    : input.testCase.model.trim()
}

function turnForMessage(
  messages: readonly ConversationMessage[],
  turnId: string | null,
  turnById: Map<string, number>
) {
  if (turnId && turnById.has(turnId)) return turnById.get(turnId)!
  return messages.filter((message) => message.role === "user").length
}

async function readTranscript(
  service: ConversationService,
  conversationId: string,
  definition: SimulationDefinitionRecord,
  input: SimulationExecutorInput
) {
  const messages = (await service.listMessages(conversationId, { limit: 200 }))
    .items
  const toolCalls = await service.listToolCalls(conversationId)
  const turnById = new Map<string, number>()
  let userTurn = 0
  for (const message of messages) {
    if (message.role === "user") userTurn += 1
    if (message.turnId && !turnById.has(message.turnId))
      turnById.set(message.turnId, Math.max(0, userTurn - 1))
  }
  const transcript: SimulationMessage[] = [
    {
      role: "system",
      content:
        input.configSnapshot.config &&
        typeof input.configSnapshot.config === "object" &&
        !Array.isArray(input.configSnapshot.config) &&
        typeof (input.configSnapshot.config as Record<string, unknown>)
          .instructions === "string"
          ? String(
              (input.configSnapshot.config as Record<string, unknown>)
                .instructions
            )
          : "",
      turn: 0,
      metadata: { source: "simulation-config" },
    },
  ]
  for (const message of messages) {
    transcript.push(
      simulationMessageSchema.parse({
        role: message.role,
        content: contentText(message.content),
        turn: turnForMessage(messages, message.turnId, turnById),
        createdAt: message.createdAt,
        metadata: message.metadata,
      })
    )
  }
  for (const call of toolCalls) {
    const output = call.output ?? (call.error ? { error: call.error } : null)
    transcript.push(
      simulationMessageSchema.parse({
        role: "tool",
        content: contentText(output),
        turn: turnForMessage(messages, call.turnId, turnById),
        createdAt: call.createdAt,
        metadata: {
          source: "action",
          actionId: call.actionId,
          toolCallId: call.toolCallId,
          status: call.status,
        },
      })
    )
  }
  transcript.sort((left, right) => {
    if (left.role === "system") return -1
    if (right.role === "system") return 1
    return (left.createdAt ?? "").localeCompare(right.createdAt ?? "")
  })
  void definition
  return { transcript, toolCalls }
}

function observedActions(toolCalls: readonly ConversationToolCall[]) {
  return toolCalls.map((call): ObservedAction =>
    observedActionSchema.parse({
      actionId: call.actionId,
      arguments: jsonValue(call.input),
      status:
        call.status === "completed"
          ? "succeeded"
          : call.status === "awaiting_client"
            ? "blocked"
            : "failed",
      ...(call.output !== null && call.output !== undefined
        ? { result: jsonValue(call.output) }
        : call.error
          ? { result: jsonValue(call.error) }
          : {}),
    })
  )
}

function simulationError(error: unknown) {
  if (error instanceof BuildRuntimeError) return error.message
  if (error instanceof Error && error.message) {
    if (
      /model|provider|gateway|request|api key|credential/i.test(error.message)
    )
      return "Simulation model request failed."
  }
  return "Simulation execution failed."
}

async function defaultCustomer(
  context: BuildContext,
  input: RuntimeSimulationCustomerInput,
  options: RuntimeSimulationExecutorOptions
): Promise<CustomerResponse | null> {
  const generate = options.generateObject ?? generateObject
  const model = options.generateObject
    ? normalizeModel(input.model, input.provider)
    : await modelFor(context, input.model, input.provider, options)
  const result = await generate({
    model,
    schema: customerResponseSchema,
    schemaName: "simulation_customer_turn",
    system:
      "You simulate a realistic customer in a customer support conversation. Stay in character, pursue the stated goal, and stop only when the issue is resolved or no useful turn remains.",
    prompt: [
      `Persona: ${input.definition.persona.name}`,
      `Traits: ${input.definition.persona.traits.join(", ") || "none"}`,
      `Goals: ${input.definition.persona.goals.join(", ") || "none"}`,
      `Context: ${input.definition.persona.context || "none"}`,
      `Scenario: ${input.definition.scenario}`,
      `Conversation:\n${input.transcript
        .map((item) => `${item.role}: ${item.content}`)
        .join("\n")}`,
      "Return the next customer message and whether the conversation is done.",
    ].join("\n\n"),
    temperature: 0.4,
    maxRetries: 0,
    abortSignal: input.signal,
  } as never)
  return customerResponseSchema.parse((result as { object: unknown }).object)
}

async function defaultJudge(
  context: BuildContext,
  input: RuntimeSimulationJudgeInput,
  options: RuntimeSimulationExecutorOptions
): Promise<SimulationVerdict | null> {
  const generate = options.generateObject ?? generateObject
  const model = options.generateObject
    ? normalizeModel(input.model, input.provider)
    : await modelFor(context, input.model, input.provider, options)
  const result = await generate({
    model,
    schema: judgeResponseSchema,
    schemaName: "simulation_verdict",
    system:
      "You are a strict evaluator of a customer support agent. Judge only the supplied transcript and observed actions. Do not infer success from an absent response or absent action. Return one criterion result for each supplied success criterion.",
    prompt: [
      `Success criteria: ${input.definition.successCriteria
        .map((criterion, index) => `${index + 1}. ${criterion}`)
        .join("\n")}`,
      `Expected actions: ${JSON.stringify(input.definition.expectedActions)}`,
      `Observed actions: ${JSON.stringify(input.observedActions)}`,
      `Transcript:\n${input.transcript
        .map((item) => `${item.role}: ${item.content}`)
        .join("\n")}`,
      "Return passed only when every required criterion is satisfied. Use no_verdict when the transcript cannot support a reliable decision.",
    ].join("\n\n"),
    temperature: 0,
    maxRetries: 0,
    abortSignal: input.signal,
  } as never)
  const object = (result as { object: unknown }).object
  if (object === null || object === undefined) return null
  const parsed = judgeResponseSchema.parse(object)
  return simulationVerdictSchema.parse(parsed)
}

async function executeRuntimeSimulationCase(
  context: BuildContext,
  input: SimulationExecutorInput,
  options: RuntimeSimulationExecutorOptions
): Promise<{
  transcript: SimulationMessage[]
  observedActions: ReturnType<typeof observedActions>
  verdict: SimulationVerdict
}> {
  const service = new ConversationService(context)
  const config = agentConfigurationSchema.parse(input.configSnapshot.config)
  const model = modelName(input)
  const provider: ModelProvider =
    config.provider === "openai" ? OPENAI_PROVIDER : GATEWAY_PROVIDER
  if (!model)
    throw new BuildRuntimeError(
      "MODEL_NOT_CONFIGURED",
      "Simulation model is not configured."
    )
  const actions = snapshotActions(input, context)
  const procedures = snapshotProcedures(input, context)
  const agent: RuntimeAgent = {
    id: input.definition.agentId,
    projectId: context.projectId,
    name: `Simulation · ${input.definition.name}`,
    slug: `simulation-${input.testCase.id}`.slice(0, 120),
    currentRevision: input.configSnapshot.agentRevision,
    appliedRevision: input.configSnapshot.agentRevision,
    configuration: { ...config, model },
  }
  const externalConversationId = `simulation:${input.run.id}:${input.testCase.id}`
  const conversation = await service.getOrCreate({
    agentId: agent.id,
    channel: input.definition.channel,
    externalConversationId,
    metadata: {
      simulationRunId: input.run.id,
      simulationCaseId: input.testCase.id,
      persona: input.definition.persona,
      scenario: input.definition.scenario,
    },
  })
  const knowledge = async (query: string) => {
    const documents = input.configSnapshot.knowledge.flatMap((source) => {
      const result = knowledgeText(source, query)
      return result ? [result] : []
    })
    if (!documents.length) return null
    return {
      text: documents
        .map((item) => item.text)
        .join("\n\n")
        .slice(0, 16_000),
      documents: documents.flatMap((item) => item.documents),
      snapshotId: `simulation:${input.run.id}:${input.configSnapshot.agentRevision}`,
    }
  }
  const actionExecutor = async (actionInput: {
    action: Parameters<
      NonNullable<RuntimeDependencies["executeAction"]>
    >[0]["action"]
    input: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<RuntimeActionExecutionResult> => {
    if (actionInput.signal?.aborted)
      throw new BuildRuntimeError(
        "TURN_CANCELLED",
        "The simulation was cancelled."
      )
    let toolCall
    try {
      toolCall = await input.callMockedTool(
        actionInput.action.id,
        actionInput.input as Record<string, JsonValue>,
        actionInput.signal
      )
    } catch (error) {
      if (actionInput.signal?.aborted)
        throw new BuildRuntimeError(
          "TURN_CANCELLED",
          "The simulation was cancelled."
        )
      return {
        status: "failed",
        output: { error: simulationError(error) },
      }
    }
    if (toolCall.error)
      return { status: "failed", output: { error: toolCall.error } }
    return { status: "completed", output: toolCall.response ?? null }
  }
  const dependencies: RuntimeDependencies = {
    resolveActions: async () => actions,
    resolveProcedures: async () => procedures,
    retrieveKnowledge: async ({ query }) => knowledge(query),
    executeAction: async ({ action, input: actionInput, signal }) =>
      actionExecutor({ action, input: actionInput, signal }),
  }
  if (options.generateText) dependencies.generateText = options.generateText
  const heartbeatIntervalMs = Math.max(
    1_000,
    Math.floor((input.leaseSeconds * 1_000) / 3)
  )
  const heartbeat = setInterval(() => {
    void input.renewLease().catch(() => {
      // A lease loss is a hard execution boundary. Abort any provider request
      // still in flight so its result cannot be written by a stale worker.
      input.abort()
    })
  }, heartbeatIntervalMs)
  let nextMessage = input.definition.initialMessage
  let conversationError: unknown = null
  try {
    for (let turn = 0; turn < input.definition.maxTurns; turn += 1) {
      await input.renewLease()
      if (input.signal.aborted || (await input.isCancelled())) break
      try {
        const result = await runAgentTurn(
          context,
          {
            agentId: agent.id,
            channel: input.definition.channel,
            conversationId: conversation.id,
            requestKey: `simulation:${input.testCase.id}:turn:${turn + 1}`,
            message: nextMessage,
            metadata: {
              simulationRunId: input.run.id,
              simulationCaseId: input.testCase.id,
              simulationTurn: turn,
            },
          },
          {
            conversationService: service,
            agent,
            dependencies,
            maxToolSteps: options.maxToolSteps,
            signal: input.signal,
          }
        )
        if (
          result.status === "blocked" ||
          result.status === "awaiting_client" ||
          result.status === "handed_off"
        )
          break
        if (turn + 1 >= input.definition.maxTurns) break
        if (input.signal.aborted || (await input.isCancelled())) break
        const current = await readTranscript(
          service,
          conversation.id,
          input.definition,
          input
        )
        const customer =
          options.customer === null
            ? null
            : options.customer
              ? await options.customer({
                  definition: input.definition,
                  testCase: input.testCase,
                  transcript: current.transcript,
                  model,
                  provider,
                  signal: input.signal,
                })
              : await defaultCustomer(
                  context,
                  {
                    definition: input.definition,
                    testCase: input.testCase,
                    transcript: current.transcript,
                    model,
                    provider,
                    signal: input.signal,
                  },
                  options
                )
        if (!customer || customer.done || !customer.message.trim()) break
        nextMessage = customer.message.trim()
      } catch (error) {
        conversationError = error
        break
      }
    }
    const current = await readTranscript(
      service,
      conversation.id,
      input.definition,
      input
    )
    const observed = observedActions(current.toolCalls)
    if (conversationError) {
      return {
        transcript: current.transcript,
        observedActions: observed,
        verdict: {
          status: "infra_error",
          reason: simulationError(conversationError),
          criteria: [],
          score: null,
        },
      }
    }
    let verdict: SimulationVerdict | null
    if (options.judge === null) {
      verdict = null
    } else if (options.judge) {
      try {
        const generated = await options.judge({
          definition: input.definition,
          testCase: input.testCase,
          transcript: current.transcript,
          observedActions: observed,
          model,
          provider,
          signal: input.signal,
        })
        verdict = generated ? simulationVerdictSchema.parse(generated) : null
      } catch (error) {
        return {
          transcript: current.transcript,
          observedActions: observed,
          verdict: {
            status: "infra_error",
            reason: simulationError(error),
            criteria: [],
            score: null,
          },
        }
      }
    } else {
      try {
        verdict = await defaultJudge(
          context,
          {
            definition: input.definition,
            testCase: input.testCase,
            transcript: current.transcript,
            observedActions: observed,
            model,
            provider,
            signal: input.signal,
          },
          options
        )
      } catch (error) {
        return {
          transcript: current.transcript,
          observedActions: observed,
          verdict: {
            status: "infra_error",
            reason: simulationError(error),
            criteria: [],
            score: null,
          },
        }
      }
    }
    if (!verdict)
      return {
        transcript: current.transcript,
        observedActions: observed,
        verdict: {
          status: "no_verdict",
          reason: "No judge result was available.",
          criteria: input.definition.successCriteria.map((criterion) => ({
            criterion,
            passed: null,
            reason: "No judge result was available.",
          })),
          score: null,
        },
      }
    return {
      transcript: current.transcript,
      observedActions: observed,
      verdict: simulationVerdictSchema.parse(verdict),
    }
  } finally {
    clearInterval(heartbeat)
  }
}

/** Build a durable worker executor that runs the real agent model and judge. */
export function createRuntimeSimulationExecutor(
  context: BuildContext,
  options: RuntimeSimulationExecutorOptions = {}
): SimulationExecutor {
  return (input) => executeRuntimeSimulationCase(context, input, options)
}

export { executeRuntimeSimulationCase }

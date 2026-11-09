import { createOpenAI } from "@ai-sdk/openai"
import { createGateway } from "@ai-sdk/gateway"
import { sql } from "drizzle-orm"
import { getModels } from "tokenlens/models"
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import type { SessionContext } from "eve/context"
import type { Fact, Progress } from "eve/events"
import { createBuildContext } from "../context"
import { createTracerDatabase } from "../../tracer/db"
import { getProjectProviderKey } from "../../model-providers/store"
import { beginModelUsage, finishModelUsage } from "../usage"
import { ConversationService } from "../conversations"
import { assertEveOwnership, assertNoUncertainEveTools, getEveExecution, patchEveState, recordEveOutcome } from "./store"
import { finalizeEveRuntimeExecution, startEveModelTrace } from "../runtime"
import type { BuildContext } from "../context"
import type { EveExecution } from "./contracts"
import { builtinEnabled } from "./builtins"

const contexts = new Map<string, BuildContext>()
export function contextForProject(projectId: string) {
  let context = contexts.get(projectId)
  if (!context) {
    context = createBuildContext(createTracerDatabase(undefined, { projectId }), { projectId })
    contexts.set(projectId, context)
  }
  return context
}

export async function executionContext(ctx: { session: Pick<SessionContext["session"], "auth"> }, requireOwnership = true) {
  const auth = ctx.session.auth.current
  if (auth?.authenticator !== "datool" || auth.principalType !== "service") throw new Error("Datool service authentication is required.")
  const projectId = auth.attributes?.projectId
  const turnId = auth.attributes?.turnId
  if (typeof projectId !== "string" || typeof turnId !== "string" || auth.principalId !== projectId) throw new Error("Invalid execution identity.")
  const context = contextForProject(projectId)
  const run = await getEveExecution(context, turnId)
  if (requireOwnership) await assertEveOwnership(context, run)
  return { context, run }
}

export async function executionModel(context: BuildContext, run: EveExecution) {
  const provider = run.plan.configuration.provider === "openai" ? "openai" : "vercel-ai-gateway"
  const apiKey = await getProjectProviderKey(context.projectId, provider, context.database)
  const modelId = run.plan.configuration.model.replace(new RegExp(`^${provider}/`), "")
  const model = provider === "openai"
    ? createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL }).responses(modelId)
    : createGateway({ apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL }).languageModel(modelId)
  function prepare(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
    const source = run.plan.messages.findLast(message => message.role === "user")
    const images = Array.isArray(source?.content) ? source.content.filter(part => part.type === "image") : []
    const lastUser = options.prompt.findLastIndex(message => message.role === "user")
    const searchEnabled = builtinEnabled(run, "web_search")
    return { ...options,
      tools: options.tools?.filter(tool => tool.name !== "web_search" || searchEnabled),
      ...(options.toolChoice?.type === "tool" && options.toolChoice.toolName === "web_search" && !searchEnabled ? { toolChoice: { type: "auto" as const } } : {}),
      prompt: images.length ? options.prompt.map((message, index) => index === lastUser && message.role === "user" ? { ...message, content: [...message.content, ...images.flatMap(part => typeof part.image === "string" ? [{ type: "file" as const, mediaType: part.mediaType ?? "image/png", data: { type: "data" as const, data: Buffer.from(part.image, "base64") } }] : [])] } : message) : options.prompt,
      maxOutputTokens: run.plan.configuration.guardrails.maxOutputTokens,
      temperature: run.plan.configuration.temperature,
      ...(provider === "openai" ? { providerOptions: { ...options.providerOptions, openai: { ...options.providerOptions?.openai, store: false } } } : {}),
    }
  }
  async function admit(options: LanguageModelV4CallOptions) {
    const current = await getEveExecution(context, run.turnId)
    await assertEveOwnership(context, current)
    await assertNoUncertainEveTools(context, current.turnId)
    // Interrupted provider requests may have incurred usage. Keep that uncertainty visible.
    await context.database.execute(sql`UPDATE build_usage_event SET status='uncertain' WHERE project_id=${context.projectId} AND turn_id=${run.turnId} AND kind='model' AND status='pending'`)
    const calls = (current.state.modelCalls ?? 0) + 1
    if (calls > current.plan.maxToolSteps) throw new Error("This turn reached its model step limit.")
    if (current.plan.budgetReservation) {
      // Conservative maximum token reservation includes history and discovered schemas.
      const usd = await import("../runtime").then(module => module.quoteEveModelCall(current.plan, options))
      const estimatedUsd = (current.state.reservedUsd ?? 0) + usd
      await new ConversationService(context).extendBudgetReservation({ agentId: run.agentId, reservationId: current.plan.budgetReservation.reservationId, ownerFence: run.ownerFence, estimatedUsd, dailyLimitUsd: current.plan.configuration.guardrails.dailyBudgetUsd! })
      await patchEveState(context, run.turnId, { reservedUsd: estimatedUsd })
    }
    await patchEveState(context, run.turnId, { modelCalls: calls })
    return beginModelUsage(context, { agentId: run.agentId, conversationId: run.conversationId, turnId: run.turnId, provider, model: modelId })
  }
  async function observeSearch(part: LanguageModelV4StreamPart) {
    if ((part.type !== "tool-call" && part.type !== "tool-result") || part.toolName !== "web_search") return
    if (!builtinEnabled(run, "web_search")) throw new Error("Web search is disabled for this execution.")
    const service = new ConversationService(context)
    const toolCallId = `eve_search_${part.toolCallId}`
    if (part.type === "tool-call") {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(part.input) } catch { /* Provider input can arrive without a query. */ }
      await service.recordToolCallStart({ conversationId: run.conversationId, turnId: run.turnId, toolCallId, actionId: "web_search", args: input, ownerFence: run.ownerFence })
    } else if (!part.preliminary) {
      await service.recordToolCallFinish({ conversationId: run.conversationId, turnId: run.turnId, toolCallId, status: part.isError ? "failed" : "completed", output: part.result, ownerFence: run.ownerFence })
    }
  }
  const wrapped: LanguageModelV4 = {
    specificationVersion: model.specificationVersion, provider: model.provider, modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      options = prepare(options)
      const id = await admit(options)
      const trace = await startEveModelTrace(context, run, options.prompt)
      try {
        const result = await model.doGenerate(options)
        for (const part of result.content) if (part.type === "tool-call" || part.type === "tool-result") await observeSearch(part)
        await finishModelUsage(context, id, result.usage, result.providerMetadata, result.response?.id)
        await trace?.(result.content, result.usage)
        return result
      } catch { await finishModelUsage(context, id); await trace?.({ error: "The model request failed." }, undefined, true, options.abortSignal?.aborted); throw new Error("The agent model request failed.", { cause: undefined }) }
    },
    async doStream(options) {
      options = prepare(options)
      const id = await admit(options)
      const trace = await startEveModelTrace(context, run, options.prompt)
      try {
        const result = await model.doStream(options)
        let finished = false
        let output = ""
        const toolCalls: unknown[] = []
        const reader = result.stream.getReader()
        return { ...result, stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) {
                if (!finished) { await finishModelUsage(context, id); await trace?.({ error: "Provider stream ended without usage." }, undefined, true) }
                controller.close()
                return
              }
              const part = next.value
              await observeSearch(part)
              if (part.type === "text-delta") output += part.delta
              if (part.type === "tool-call") toolCalls.push(part)
              if (part.type === "finish") { await finishModelUsage(context, id, part.usage, part.providerMetadata); await trace?.({ text: output, toolCalls }, part.usage); finished = true }
              if (part.type === "error") { await finishModelUsage(context, id); await trace?.({ error: "The model stream failed." }, undefined, true); finished = true; controller.error(new Error("The model stream failed.")); return }
              controller.enqueue(part)
            } catch {
              await finishModelUsage(context, id)
              await trace?.({ error: "The model stream failed." }, undefined, true, options.abortSignal?.aborted)
              controller.error(new Error("The model stream failed."))
            }
          },
          async cancel() {
            await reader.cancel()
            if (!finished) { await finishModelUsage(context, id); await trace?.({ error: "The model request was cancelled." }, undefined, false, true) }
          },
        }) }
      } catch { await finishModelUsage(context, id); await trace?.({ error: "The model request failed." }, undefined, true, options.abortSignal?.aborted); throw new Error("The agent model request failed.", { cause: undefined }) }
    },
  }
  const slash = modelId.indexOf("/")
  const catalogProvider = slash < 0 ? "openai" : modelId.slice(0, slash)
  const catalogId = slash < 0 ? modelId : modelId.slice(slash + 1)
  const catalog = getModels() as Record<string, { models?: Record<string, { limit?: { context?: number } }> }>
  const window = catalog[catalogProvider]?.models?.[catalogId]?.limit?.context
  return { model: wrapped, modelContextWindowTokens: typeof window === "number" && window > 0 ? window : 128_000 }
}

/** Read Eve's durable stream when a crash interrupted its final projection hook. */
export async function synchronizeExecution(context: BuildContext, turnId: string, events: AsyncIterable<Fact | Progress>) {
  const contents = new Map<string, string>()
  for await (const event of events) {
    if (event.type === "content.completed" && event.data.kind === "text") contents.set(event.data.partId, String(event.data.value ?? ""))
    if (event.type === "turn.settled") {
      await recordEveOutcome(context, turnId, { status: event.data.outcome,
        text: (event.data.reply ?? []).map(id => contents.get(id) ?? "").join("\n"),
        ...(event.data.error ? { error: { code: event.data.error.code, message: "The agent execution failed." } } : {}),
      })
      await finalizeEveRuntimeExecution(context, turnId)
    }
  }
  await context.database.execute(sql`UPDATE build_eve_executions SET updated_at=now() WHERE project_id=${context.projectId} AND turn_id=${turnId}`)
}

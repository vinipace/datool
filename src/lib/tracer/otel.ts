import { datoolCallAttributes, getDatoolCallContext } from "./call-context.ts"
import { DatoolClient, type DatoolClientOptions } from "./client.ts"
import type { JsonObject, JsonValue, SpanKind } from "./contracts.ts"
import { otelInvocationGroup } from "./groups.ts"
import { priceLlm, priceLlmWithCatalog } from "./pricing.ts"
import {
  defaultPricingCatalog,
  PricingCatalog,
  type PricingCatalogOptions,
} from "./pricing-catalog.ts"
export type { PricingCatalogOptions } from "./pricing-catalog.ts"
import { aggregateLlmUsage } from "./usage.ts"

// Structural OTel interfaces avoid installing a second copy of the global API
// in the application. Compatible with sdk-trace-base 1.x and 2.x processors.
export type OtelSpan = {
  instrumentationScope?: { name: string }
  name: string
  attributes: Record<string, unknown>
  startTime: [number, number]
  endTime?: [number, number]
  status: { code: number; message?: string }
  parentSpanContext?: { spanId: string }
  parentSpanId?: string
  spanContext(): { traceId: string; spanId: string }
  events?: readonly { name: string; attributes?: Record<string, unknown> }[]
  resource?: { attributes: Record<string, unknown> }
}

export type DatoolSpanProcessorOptions = DatoolClientOptions & {
  /** Cached model pricing, refreshed independently of the Datool transport. */
  pricing?: PricingCatalogOptions
  /** Extra attributes are captured at span start, including async request context. */
  attributes?: JsonObject | ((span: OtelSpan) => JsonObject)
  sessionId?: string
  shouldExport?: (span: OtelSpan) => boolean
  /** Transform lifecycle payloads before they enter the transport/ingestion queue. */
  transform?: (data: unknown) => unknown
  /** Schedule a framework-specific flush once all spans in a trace have ended. */
  onTraceEnd?: () => void
}

type TraceState = {
  external?: boolean
  rootId: string
  active: number
  failed: boolean
  cancelled: boolean
  endedAt?: string
  rootFields?: ReturnType<typeof fields>
  records: Map<string, SpanState>
}
type SpanState = {
  attributes: JsonObject
  correlation: Record<string, string>
  traceId: string
  trace: TraceState
  parentId: string | null
  hidden: boolean
  kind: SpanKind
  final?: ReturnType<typeof fields>
}

function json(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue
    } catch {
      return value
    }
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function timestamp(value: [number, number]) {
  return new Date(value[0] * 1000 + value[1] / 1e6).toISOString()
}

function kind(span: OtelSpan): SpanKind {
  const explicit = span.attributes["datool.span.kind"]
  if (
    typeof explicit === "string" &&
    [
      "agent",
      "custom",
      "function",
      "llm",
      "score",
      "task",
      "tool",
      "workflow",
    ].includes(explicit)
  )
    return explicit as SpanKind
  if (
    span.name === "ai.toolCall" ||
    span.attributes["gen_ai.operation.name"] === "execute_tool"
  )
    return "tool"
  if (
    /^ai\.(generateText|streamText|generateObject|streamObject)\./.test(
      span.name
    ) ||
    span.attributes["gen_ai.operation.name"] === "chat"
  )
    return "llm"
  if (
    /^ai\.(generateText|streamText|generateObject|streamObject)$/.test(
      span.name
    )
  )
    return "function"
  return "custom"
}

function fields(span: OtelSpan, extra: JsonObject) {
  const a = span.attributes
  const attributes = json({
    ...span.resource?.attributes,
    ...extra,
    ...a,
  }) as JsonObject
  attributes["otel.name"] = span.name
  if (span.events?.length) attributes["otel.events"] = json(span.events)
  if (span.status.message) attributes["error.message"] = span.status.message
  const tool = kind(span) === "tool"
  const input = json(
    tool
      ? (a["ai.toolCall.args"] ??
          a["ai.toolCall.input"] ??
          a["gen_ai.tool.call.arguments"])
      : (a["input"] ??
          a["ai.prompt.messages"] ??
          a["ai.prompt"] ??
          a["gen_ai.input.messages"])
  )
  const text = a["ai.response.text"]
  const calls = a["ai.response.toolCalls"]
  const output = json(
    tool
      ? (a["ai.toolCall.result"] ?? a["gen_ai.tool.call.result"])
      : (a["output"] ??
          (calls ? { text: text ?? "", toolCalls: json(calls) } : text) ??
          a["ai.response.object"] ??
          a["gen_ai.output.messages"])
  )
  return {
    attributes: kind(span) === "llm" ? priceLlm(attributes) : attributes,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

/**
 * Add to NodeSDK.spanProcessors. Writes starts immediately, then final I/O,
 * timing, errors and usage at span end. forceFlush rejects on delivery failure.
 * This uses Datool's JSON lifecycle API; it is not an OTLP collector.
 */
export class DatoolSpanProcessor {
  private readonly client: DatoolClient
  private readonly options: DatoolSpanProcessorOptions
  private readonly pricing: PricingCatalog
  private readonly spans = new Map<string, SpanState>()
  private readonly traces = new Map<string, TraceState>()
  private queue: Promise<void> = Promise.resolve()
  private failure: Error | undefined
  private closed = false

  constructor(options: DatoolSpanProcessorOptions = {}) {
    this.client = new DatoolClient(options)
    this.options = options
    this.pricing = options.pricing
      ? new PricingCatalog(options.pricing)
      : defaultPricingCatalog
  }

  onStart(span: OtelSpan): void {
    if (this.closed || this.options.shouldExport?.(span) === false) return
    const { traceId: originalTraceId, spanId } = span.spanContext()
    const externalTraceId = getDatoolCallContext()?.invocationTraceId
    const traceId = externalTraceId ?? originalTraceId
    const parent = span.parentSpanContext?.spanId ?? span.parentSpanId
    const parentId =
      parent && this.spans.get(parent)?.traceId === traceId ? parent : null
    let state = this.traces.get(traceId)
    const correlation = datoolCallAttributes()
    const group = otelInvocationGroup(span.attributes)
    const attributes =
      typeof this.options.attributes === "function"
        ? this.options.attributes(span)
        : (this.options.attributes ?? {})
    const initial = fields(span, attributes)
    Object.assign(initial.attributes, correlation)
    const startedAt = timestamp(span.startTime)
    if (!state) {
      state = {
        external: !!externalTraceId,
        rootId: spanId,
        active: 0,
        failed: false,
        cancelled: false,
        records: new Map(),
      }
      this.traces.set(traceId, state)
      const functionId =
        span.attributes["ai.telemetry.functionId"] ??
        span.attributes["ai.functionId"]
      if (!externalTraceId)
        this.enqueue(() =>
          this.request("/api/traces", "POST", {
            id: traceId,
            name: String(functionId ?? span.name).slice(0, 200),
            operation: span.name.slice(0, 200),
            ...(span.attributes["datool.trace.root"] === true ? { group } : {}),
            sessionId: this.options.sessionId,
            startedAt,
            status: "running",
            ...initial,
          })
        )
    }
    state.active++
    const hidden =
      !externalTraceId &&
      span.attributes["datool.trace.root"] === true &&
      state.rootId === spanId
    const record: SpanState = {
      attributes,
      correlation,
      traceId,
      trace: state,
      parentId,
      hidden,
      kind: kind(span),
    }
    this.spans.set(spanId, record)
    state.records.set(spanId, record)
    if (hidden) return
    const name =
      record.kind === "tool"
        ? (span.attributes["ai.toolCall.name"] ??
          span.attributes["gen_ai.tool.name"] ??
          span.name)
        : record.kind === "function"
          ? (span.attributes["ai.telemetry.functionId"] ?? span.name)
          : span.name
    const exportedParentId =
      parentId && this.spans.get(parentId)?.hidden ? null : parentId
    this.enqueue(() =>
      this.request(`/api/traces/${traceId}/spans`, "POST", {
        id: spanId,
        parentId: exportedParentId,
        name: String(name).slice(0, 200),
        kind: kind(span),
        group,
        startedAt,
        status: "running",
        ...initial,
      })
    )
  }

  onEnd(span: OtelSpan): void {
    const { spanId } = span.spanContext()
    const state = this.spans.get(spanId)
    if (!state || state.final) return
    const status =
      span.status.code === 2
        ? "errored"
        : span.attributes["datool.span.cancelled"] === true
          ? "cancelled"
          : "completed"
    const endedAt = timestamp(span.endTime ?? span.startTime)
    const final = fields(span, state.attributes)
    Object.assign(final.attributes, state.correlation)
    state.final = final
    this.enqueue(async () => {
      if (state.kind === "llm")
        final.attributes = await priceLlmWithCatalog(
          final.attributes,
          this.pricing
        )
      if (!state.hidden)
        await this.request(`/api/spans/${spanId}`, "PATCH", {
          ...final,
          status,
          endedAt,
        })
    })
    state.trace.failed ||= status === "errored"
    state.trace.cancelled ||= status === "cancelled"
    state.trace.endedAt =
      state.trace.endedAt && state.trace.endedAt > endedAt
        ? state.trace.endedAt
        : endedAt
    if (state.trace.rootId === spanId) {
      state.trace.rootFields = final
    }
    state.trace.active--
    if (state.trace.active === 0) {
      // The queue prices every completed LLM before deriving inclusive totals.
      this.enqueue(async () => {
        // Derive wrapper and trace totals from the captured LLM calls exactly
        // once. SDK function usage is already inclusive and is never added.
        for (const [id, record] of state.trace.records) {
          if (record.kind === "llm" || !record.final || record.hidden) continue
          const llms = this.descendantLlms(state.trace, id)
          if (!llms.length) continue
          const attributes = {
            ...record.final.attributes,
            ...aggregateLlmUsage(llms),
          }
          if ((attributes.models as unknown[])?.length !== 1)
            delete attributes.model
          await this.request(`/api/spans/${id}`, "PATCH", { attributes })
        }
        const llms = [...state.trace.records.values()].flatMap((record) =>
          record.kind === "llm" && record.final ? [record.final.attributes] : []
        )
        const root = state.trace.rootFields
        const attributes = { ...root?.attributes, ...aggregateLlmUsage(llms) }
        if ((attributes.models as unknown[])?.length !== 1)
          delete attributes.model
        if (!state.trace.external)
          await this.request(`/api/traces/${state.traceId}`, "PATCH", {
            ...state.trace.rootFields,
            attributes,
            endedAt: state.trace.endedAt,
            status: state.trace.failed
              ? "errored"
              : state.trace.cancelled
                ? "cancelled"
                : "completed",
          })
      })
      for (const id of state.trace.records.keys()) this.spans.delete(id)
      this.traces.delete(state.traceId)
      this.options.onTraceEnd?.()
    }
  }

  private descendantLlms(trace: TraceState, parent: string) {
    return [...trace.records.values()].flatMap((record) => {
      if (record.kind !== "llm" || !record.final) return []
      let id = record.parentId
      while (id) {
        if (id === parent) return [record.final.attributes]
        id = trace.records.get(id)?.parentId ?? null
      }
      return []
    })
  }

  async forceFlush(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
    await this.client.forceFlush()
    if (this.failure) throw this.failure
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.forceFlush()
  }

  private request(path: string, method: "POST" | "PATCH", body: unknown) {
    return this.client.request(
      path,
      method,
      this.options.transform ? this.options.transform(body) : body
    )
  }

  private enqueue(work: () => Promise<unknown>) {
    this.queue = this.queue
      .then(async () => {
        await work()
      })
      .catch((error: unknown) => {
        this.failure ??=
          error instanceof Error
            ? error
            : new Error("Datool trace delivery failed")
      })
  }
}

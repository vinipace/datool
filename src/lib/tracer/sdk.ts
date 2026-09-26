import { queuedRequest } from "./queued-request"
import { IngestionSequence } from "./ingestion-sequence"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { namedInvocationGroup as namedGroup } from "./groups"
import { OtelTracer, type OtelTracerOptions } from "./otel-tracer"

import type {
  ApiEnvelope,
  CreateSessionInput,
  CreateSpanInput,
  CreateTraceInput,
  JsonObject,
  JsonValue,
  PatchSpanInput,
  PatchTraceInput,
  Session,
  Span,
  SpanKind,
  SpanStatus,
  TraceStatus,
  TraceSummary,
} from "@/src/lib/tracer/contracts"

const DEFAULT_BASE_URL = "http://127.0.0.1:3000"
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type ActiveContext = {
  sessionId: string | null
  spanId: string | null
  traceId: string
}

export type TracerOptions = {
  delivery?: "queued" | "direct"
  retries?: number
  apiKey?: string
  baseUrl?: string
  clock?: () => Date
  fetch?: FetchLike
  headers?: Record<string, string>
  requestTimeoutMs?: number
  projectId?: string
}

export type StartTraceOptions = Omit<
  CreateTraceInput,
  "endedAt" | "id" | "spans" | "startedAt" | "status"
> & {
  id?: string
}

export type StartSpanOptions = Omit<
  CreateSpanInput,
  "endedAt" | "id" | "parentId" | "startedAt" | "status"
> & {
  id?: string
  parentId?: string | null
}

export type NamedWorkflowOptions = StartTraceOptions & { name: string }
export type NamedSpanOptions = Omit<StartSpanOptions, "kind"> & { name: string }

function costAttributes(usd: number): JsonObject {
  if (!Number.isFinite(usd) || usd < 0)
    throw new Error("Reported USD cost must be a finite, nonnegative number")
  return { "cost.usd": usd }
}

export type EndTraceOptions = Omit<PatchTraceInput, "endedAt" | "status"> & {
  status?: Extract<TraceStatus, "cancelled" | "completed" | "errored">
}

export type EndSpanOptions = Omit<PatchSpanInput, "endedAt" | "status"> & {
  status?: Extract<SpanStatus, "cancelled" | "completed" | "errored">
}

export class TracerRequestError extends Error {
  readonly details: unknown
  readonly status: number | null

  constructor(
    message: string,
    options?: { cause?: unknown; details?: unknown; status?: number | null }
  ) {
    super(message, { cause: options?.cause })
    this.name = "TracerRequestError"
    this.details = options?.details
    this.status = options?.status ?? null
  }
}

function errorAttributes(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      "error.message": error.message.slice(0, 1_000),
      "error.name": error.name,
    }
  }

  return { "error.message": String(error).slice(0, 1_000) }
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

function asApiEnvelope<T>(value: unknown): ApiEnvelope<T> {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new TracerRequestError(
      "Tracer API returned an invalid response envelope"
    )
  }

  return value as ApiEnvelope<T>
}

/**
 * A Node-only client for recording traces while a workflow is executing.
 * Each start/end operation is posted immediately so the UI can render a live
 * trace and nested span graph before the workflow finishes.
 */
export class DatoolTracer {
  private readonly baseUrl: string
  private readonly clock: () => Date
  private readonly context = new AsyncLocalStorage<ActiveContext>()
  private readonly fetchImpl: FetchLike
  private readonly headers: Record<string, string>
  private readonly requestTimeoutMs: number
  private readonly delivery: "queued" | "direct"
  private readonly retries: number
  private readonly sequence = new IngestionSequence(event => queuedRequest({
    baseUrl: this.baseUrl,
    headers: this.headers,
    fetch: this.fetchImpl as typeof fetch,
    timeoutMs: this.requestTimeoutMs,
    retries: this.retries,
    event,
    waitForSaved: true,
  }))

  constructor(options: TracerOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.DATOOL_BASE_URL ??
      process.env.DATOOL_TRACE_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, "")
    this.delivery = options.delivery ?? "queued"
    this.retries = options.retries ?? 8
    this.clock = options.clock ?? (() => new Date())
    this.fetchImpl = options.fetch ?? globalThis.fetch
    const apiKey = options.apiKey ?? process.env.DATOOL_API_KEY
    this.headers = {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...((options.projectId ?? process.env.DATOOL_PROJECT_ID)
        ? {
            "x-project-id": (options.projectId ??
              process.env.DATOOL_PROJECT_ID)!,
          }
        : {}),
      ...options.headers,
    }
    this.requestTimeoutMs = Math.max(
      100,
      Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    )

    if (!this.fetchImpl) {
      throw new Error("DatoolTracer requires a Node.js fetch implementation")
    }
  }

  async createSession(input: CreateSessionInput = {}) {
    const id = input.id ?? makeId("ses")
    const session = await this.request<Session>("/api/sessions", "POST", {
      ...input,
      id,
    })

    return session
  }

  async withSession<T>(sessionId: string, work: () => Promise<T> | T) {
    const current = this.context.getStore()

    return this.context.run(
      {
        sessionId,
        spanId: current?.spanId ?? null,
        traceId: current?.traceId ?? "",
      },
      work
    )
  }

  async startTrace(options: StartTraceOptions = {}): Promise<LiveTrace> {
    const current = this.context.getStore()
    const id = options.id ?? makeId("tr")
    const sessionId = options.sessionId ?? current?.sessionId ?? undefined
    const body: CreateTraceInput = {
      ...options,
      id,
      ...(sessionId ? { sessionId } : {}),
      startedAt: this.now(),
      status: "running",
    }

    const trace = await this.request<TraceSummary>("/api/traces", "POST", body)

    return new LiveTrace(this, {
      attributes: options.attributes,
      id: trace.id,
      sessionId: trace.sessionId,
    })
  }

  async trace<T extends JsonValue>(
    options: StartTraceOptions,
    work: (trace: LiveTrace) => Promise<T> | T
  ): Promise<T> {
    const trace = await this.startTrace(options)

    return this.runTrace(trace, work)
  }

  /** Record a named top-level workflow; name is stable across invocations. */
  workflow<T extends JsonValue>(
    options: NamedWorkflowOptions,
    work: (trace: LiveTrace) => Promise<T> | T
  ): Promise<T> {
    return this.trace(
      { ...options, group: namedGroup("workflow", options) },
      work
    )
  }

  /** Record an agent within the active trace, preserving async parent context. */
  agent<T extends JsonValue>(
    options: NamedSpanOptions,
    work: (span: LiveSpan) => Promise<T> | T
  ): Promise<T> {
    const traceId = this.context.getStore()?.traceId
    if (!traceId)
      throw new Error(
        "Run tracer.agent inside tracer.trace/workflow, or use trace.agent"
      )
    return this.startSpan(traceId, {
      ...options,
      kind: "agent",
      group: namedGroup("agent", options),
    }).then((span) => this.runSpan(span, work))
  }

  updateTraceAttributes(id: string, attributes: JsonObject) {
    return this.request<TraceSummary>(
      `/api/traces/${encodeURIComponent(id)}`,
      "PATCH",
      { attributes }
    )
  }

  updateSpanAttributes(id: string, attributes: JsonObject) {
    return this.request<Span>(`/api/spans/${encodeURIComponent(id)}`, "PATCH", {
      attributes,
    })
  }

  async startSpan(
    traceId: string,
    options: StartSpanOptions
  ): Promise<LiveSpan> {
    const current = this.context.getStore()
    const id = options.id ?? makeId("sp")
    const { parentId: requestedParentId, ...spanOptions } = options
    const parentId =
      requestedParentId ??
      (current?.traceId === traceId ? current.spanId : null)
    const body: CreateSpanInput = {
      ...spanOptions,
      id,
      ...(parentId ? { parentId } : {}),
      startedAt: this.now(),
      status: "running",
    }
    const span = await this.request<Span>(
      `/api/traces/${encodeURIComponent(traceId)}/spans`,
      "POST",
      body
    )

    return new LiveSpan(this, {
      attributes: options.attributes,
      id: span.id,
      parentId: span.parentId,
      traceId: span.traceId,
    })
  }

  async finishTrace(id: string, options: EndTraceOptions = {}) {
    return this.request<TraceSummary>(
      `/api/traces/${encodeURIComponent(id)}`,
      "PATCH",
      {
        ...options,
        endedAt: this.now(),
        status: options.status ?? "completed",
      }
    )
  }

  async finishSpan(id: string, options: EndSpanOptions = {}) {
    return this.request<Span>(`/api/spans/${encodeURIComponent(id)}`, "PATCH", {
      ...options,
      endedAt: this.now(),
      status: options.status ?? "completed",
    })
  }

  async runTrace<T extends JsonValue>(
    trace: LiveTrace,
    work: (trace: LiveTrace) => Promise<T> | T
  ): Promise<T> {
    return this.context.run(
      {
        sessionId: trace.sessionId,
        spanId: null,
        traceId: trace.id,
      },
      async () => {
        try {
          const output = await work(trace)
          await trace.end({ output })
          return output
        } catch (error) {
          await trace.end({
            attributes: errorAttributes(error),
            status: "errored",
          })
          throw error
        }
      }
    )
  }

  async runSpan<T extends JsonValue>(
    span: LiveSpan,
    work: (span: LiveSpan) => Promise<T> | T
  ): Promise<T> {
    const current = this.context.getStore()

    return this.context.run(
      {
        sessionId: current?.sessionId ?? null,
        spanId: span.id,
        traceId: span.traceId,
      },
      async () => {
        try {
          const output = await work(span)
          await span.end({ output })
          return output
        } catch (error) {
          await span.end({
            attributes: errorAttributes(error),
            status: "errored",
          })
          throw error
        }
      }
    )
  }

  now() {
    return this.clock().toISOString()
  }

  private async request<T>(
    path: string,
    method: "PATCH" | "POST",
    body: object
  ): Promise<T> {
    if (this.delivery === "queued") {
      return this.sequence.request<T>({ path, method, body })
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...this.headers,
        },
        method,
        signal: controller.signal,
      })
      const text = await response.text()
      let payload: unknown = null

      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          throw new TracerRequestError("Tracer API returned invalid JSON", {
            status: response.status,
          })
        }
      }

      if (!response.ok) {
        const message =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          payload.error &&
          typeof payload.error === "object" &&
          "message" in payload.error &&
          typeof payload.error.message === "string"
            ? payload.error.message
            : `Tracer API request failed with status ${response.status}`

        throw new TracerRequestError(message, {
          details: payload,
          status: response.status,
        })
      }

      return asApiEnvelope<T>(payload).data
    } catch (error) {
      if (error instanceof TracerRequestError) {
        throw error
      }

      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Tracer API request timed out after ${this.requestTimeoutMs} ms`
          : error instanceof Error
            ? `Tracer API request failed: ${error.message}`
            : "Tracer API request failed"

      throw new TracerRequestError(message, { cause: error })
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class LiveTrace {
  private attributes: JsonObject
  readonly id: string
  readonly sessionId: string | null

  constructor(
    private readonly tracer: DatoolTracer,
    values: { attributes?: JsonObject; id: string; sessionId: string | null }
  ) {
    this.id = values.id
    this.sessionId = values.sessionId
    this.attributes = { ...values.attributes }
  }

  end(options: EndTraceOptions = {}) {
    this.attributes = { ...this.attributes, ...options.attributes }
    return this.tracer.finishTrace(this.id, {
      ...options,
      attributes: this.attributes,
    })
  }

  run<T extends JsonValue>(work: (trace: LiveTrace) => Promise<T> | T) {
    return this.tracer.runTrace(this, work)
  }

  /** Report the inclusive USD total for this invocation without ending it. */
  recordCost(usd: number) {
    this.attributes = { ...this.attributes, ...costAttributes(usd) }
    return this.tracer.updateTraceAttributes(this.id, this.attributes)
  }

  agent<T extends JsonValue>(
    options: NamedSpanOptions,
    work: (span: LiveSpan) => Promise<T> | T
  ) {
    return this.span(
      { ...options, kind: "agent", group: namedGroup("agent", options) },
      work
    )
  }

  workflow<T extends JsonValue>(
    options: NamedSpanOptions,
    work: (span: LiveSpan) => Promise<T> | T
  ) {
    return this.span(
      { ...options, kind: "workflow", group: namedGroup("workflow", options) },
      work
    )
  }

  startSpan(options: StartSpanOptions) {
    return this.tracer.startSpan(this.id, options)
  }

  span<T extends JsonValue>(
    options: StartSpanOptions,
    work: (span: LiveSpan) => Promise<T> | T
  ) {
    return this.startSpan(options).then((span) =>
      this.tracer.runSpan(span, work)
    )
  }
}

export class LiveSpan {
  private attributes: JsonObject
  readonly id: string
  readonly parentId: string | null
  readonly traceId: string

  constructor(
    private readonly tracer: DatoolTracer,
    values: {
      attributes?: JsonObject
      id: string
      parentId: string | null
      traceId: string
    }
  ) {
    this.id = values.id
    this.parentId = values.parentId
    this.traceId = values.traceId
    this.attributes = { ...values.attributes }
  }

  end(options: EndSpanOptions = {}) {
    this.attributes = { ...this.attributes, ...options.attributes }
    return this.tracer.finishSpan(this.id, {
      ...options,
      attributes: this.attributes,
    })
  }

  /** Report the inclusive USD total for this span without ending it. */
  recordCost(usd: number) {
    this.attributes = { ...this.attributes, ...costAttributes(usd) }
    return this.tracer.updateSpanAttributes(this.id, this.attributes)
  }

  run<T extends JsonValue>(work: (span: LiveSpan) => Promise<T> | T) {
    return this.tracer.runSpan(this, work)
  }
}

export function createTracer(options: OtelTracerOptions): OtelTracer
export function createTracer(options?: TracerOptions): DatoolTracer
export function createTracer(
  options: TracerOptions | OtelTracerOptions = {}
): DatoolTracer | OtelTracer {
  return "transport" in options
    ? new OtelTracer(options)
    : new DatoolTracer(options)
}

export type { SpanKind }
export { OtelTracer }
export type {
  OtelTracerOptions,
  OtelOperationOptions,
  OtelInvocationOptions,
  OtelStreamOptions,
} from "./otel-tracer"

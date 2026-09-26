import {
  context,
  createContextKey,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api"
import {
  invocationGroupSchema,
  namedInvocationGroup,
  type InvocationGroup,
} from "./groups"
import type { SpanKind } from "./contracts"

const INVOCATION = createContextKey("datool.otel.invocation")

export type OtelTracerOptions = {
  transport: "otel"
  /** Instrumentation scope. Uses the application's registered OTel provider. */
  name?: string
  version?: string | (() => string | undefined)
  /** Bound recorded I/O, without changing values returned to the application. */
  maxInputOutputCharacters?: number
}

export type OtelOperationOptions = {
  name: string
  input?: unknown
  attributes?: Attributes
  group?: InvocationGroup
  recordInputs?: boolean
  recordOutputs?: boolean
}
export type OtelInvocationOptions = OtelOperationOptions
export type OtelStreamOptions<T> = OtelInvocationOptions & {
  /** Select the output represented by each chunk. Undefined skips a chunk. */
  mapOutput?: (chunk: T) => unknown
}

function encode(value: unknown, limit: number): string {
  const valueType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value
  try {
    const serialized = JSON.stringify(value) ?? "null"
    return serialized.length <= limit
      ? serialized
      : JSON.stringify({
          truncated: true,
          originalCharacters: serialized.length,
          valueType,
        })
  } catch {
    return JSON.stringify({
      unavailable: true,
      reason: "non-serializable",
      valueType,
    })
  }
}

/** Workflow/agent helpers backed by the application's existing OTel pipeline. */
export class OtelTracer {
  private readonly limit: number
  constructor(private readonly options: OtelTracerOptions) {
    this.limit = options.maxInputOutputCharacters ?? 20_000
    if (!Number.isSafeInteger(this.limit) || this.limit < 1)
      throw new Error("maxInputOutputCharacters must be a positive integer")
  }

  workflow<T>(
    options: OtelInvocationOptions,
    work: (span: Span) => T | Promise<T>
  ): Promise<T> {
    return this.observe("workflow", options, work)
  }

  agent<T>(
    options: OtelInvocationOptions,
    work: (span: Span) => T | Promise<T>
  ): Promise<T> {
    return this.observe("agent", options, work)
  }

  span<T>(
    options: OtelOperationOptions & { kind: SpanKind },
    work: (span: Span) => T | Promise<T>
  ): Promise<T> {
    return this.observe(options.kind, options, work)
  }

  private start(
    kind: SpanKind,
    options: OtelInvocationOptions,
    parent = context.active()
  ) {
    const invocation = kind === "workflow" || kind === "agent"
    const activeParent =
      parent.getValue(INVOCATION) && trace.getSpan(parent)?.isRecording()
    // Ignore unrelated request spans for top-level named invocations. Nested
    // calls share context with AI SDK spans and other instrumented operations.
    const base = invocation && !activeParent ? trace.deleteSpan(parent) : parent
    const group = invocation
      ? namedInvocationGroup(kind, options)
      : options.group
        ? invocationGroupSchema.parse(options.group)
        : undefined
    const defaultVersion =
      typeof this.options.version === "function"
        ? this.options.version()
        : this.options.version
    const version =
      group?.version === null ? undefined : (group?.version ?? defaultVersion)
    const span = trace
      .getTracer(this.options.name ?? "datool", defaultVersion)
      .startSpan(
        options.name,
        {
          attributes: {
            ...options.attributes,
            "datool.span.kind": kind,
            ...(invocation ? { "datool.trace.root": true } : {}),
            ...(group
              ? {
                  "datool.group.type": group.type,
                  "datool.group.name": group.name,
                  ...(version ? { "datool.group.version": version } : {}),
                }
              : {}),
            ...(options.recordInputs !== false && options.input !== undefined
              ? { input: encode(options.input, this.limit) }
              : {}),
          },
        },
        base
      )
    return {
      span,
      active: trace.setSpan(
        invocation ? base.setValue(INVOCATION, true) : base,
        span
      ),
    }
  }

  private failed(span: Span, error: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: String(error instanceof Error ? error.message : error).slice(
        0,
        this.limit
      ),
    })
  }

  private async observe<T>(
    kind: SpanKind,
    options: OtelInvocationOptions,
    work: (span: Span) => T | Promise<T>
  ): Promise<T> {
    const { span, active } = this.start(kind, options)
    try {
      const result = await context.with(active, work, undefined, span)
      if (options.recordOutputs !== false)
        span.setAttribute("output", encode(result, this.limit))
      return result
    } catch (error) {
      this.failed(span, error)
      throw error
    } finally {
      span.end()
    }
  }

  agentStream<T, R = void, N = unknown>(
    options: OtelStreamOptions<T>,
    source: () => AsyncGenerator<T, R, NoInfer<N>>
  ): AsyncGenerator<T, R, N> {
    const parent = context.active()
    let operation: { span: Span; active: Context } | undefined
    let iterator: AsyncGenerator<T, R, N> | undefined
    let ended = false
    let cancelled = false
    let output: unknown
    let text = ""
    let characters = 0
    let pending: Promise<unknown> = Promise.resolve()

    const advance = (method: "next" | "return" | "throw", value: unknown) => {
      // Native async generators serialize concurrent next/return/throw calls.
      const result = pending.then(async (): Promise<IteratorResult<T, R>> => {
        if (!operation && method !== "next") {
          ended = true
          if (method === "throw") throw value
          return { done: true, value: (await value) as R }
        }
        if (ended) {
          if (method === "throw") throw value
          return {
            done: true,
            value: (method === "return" ? await value : undefined) as R,
          }
        }
        operation ??= this.start("agent", options, parent)
        const { span, active } = operation
        try {
          iterator ??= context.with(active, source)
          if (method === "return") cancelled = true
          const next = await context.with(active, () => {
            if (method === "throw") return iterator!.throw(value)
            if (method === "return") return iterator!.return(value as R)
            return iterator!.next(value as N)
          })
          if (options.recordOutputs !== false && !next.done) {
            const chunk = options.mapOutput
              ? options.mapOutput(next.value)
              : next.value
            if (typeof chunk === "string") {
              characters += chunk.length
              if (characters <= this.limit) text += chunk
              output =
                characters <= this.limit
                  ? text
                  : {
                      truncated: true,
                      originalCharacters: characters,
                      valueType: "string",
                    }
            } else if (chunk !== undefined) {
              // Encode now to avoid retaining large mutable chunk objects.
              output = JSON.parse(encode(chunk, this.limit))
            }
          }
          if (next.done) {
            ended = true
            if (cancelled) span.setAttribute("datool.span.cancelled", true)
            if (options.recordOutputs !== false)
              span.setAttribute("output", encode(output, this.limit))
            span.end()
          }
          return next
        } catch (error) {
          ended = true
          this.failed(span, error)
          try {
            await context.with(active, () => iterator?.return(undefined as R))
          } catch {
            /* Preserve the original source/capture error. */
          } finally {
            span.end()
          }
          throw error
        }
      })
      pending = result.catch(() => {})
      return result
    }
    return {
      next: (...args: [] | [N]) => advance("next", args[0]),
      return: (value: R | PromiseLike<R>) => advance("return", value),
      throw: (error: unknown) => advance("throw", error),
      [Symbol.asyncIterator]() {
        return this
      },
    } as AsyncGenerator<T, R, N>
  }
}

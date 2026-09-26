import type { ApiList, Span, SpanOverview, TraceDetail, TraceOverview, TraceSummary } from "@/src/lib/tracer/contracts"
import { tracerApi, type CollectionListOptions } from "./api"

/** Payload consumers must finish every page before presenting complete evidence. */
export async function readAllTracePages<T>(
  list: (options: CollectionListOptions) => Promise<ApiList<T>>,
  signal: AbortSignal,
): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await list({ cursor, limit: 200, signal })
    signal.throwIfAborted()
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
    if (cursor && seen.has(cursor)) throw new Error("Trace pagination did not advance. Retry loading the trace.")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return items
}

/** A cache belongs to one inspector session, never to another project or trace. */
export function createTraceDetailLoader(traceId: string, snapshot?: TraceDetail) {
  const spans = new Map<string, Span>()
  let payload: TraceSummary | undefined
  let opened = false
  const matches = (cached: Span | TraceSummary | undefined, summary: SpanOverview | TraceOverview) =>
    cached?.status === summary.status && cached?.endedAt === summary.endedAt
  const current = (cached: Span | TraceSummary | undefined, summary: SpanOverview | TraceOverview) =>
    cached?.status !== "running" && matches(cached, summary)

  return {
    async overview(signal: AbortSignal): Promise<TraceOverview> {
      if (snapshot) return snapshot
      const trace = await tracerApi.traces.overview(traceId, signal, !opened)
      signal.throwIfAborted()
      if (trace.rootDetail) {
        if ("kind" in trace.rootDetail) spans.set(trace.rootDetail.id, trace.rootDetail)
        else payload = trace.rootDetail
      }
      opened = true
      return trace
    },
    /** Render already received details synchronously, without a second spinner. */
    peek(trace: TraceOverview, span?: SpanOverview): Span | TraceSummary | undefined {
      const cached = span ? snapshot?.spans.find(item => item.id === span.id) ?? spans.get(span.id) : snapshot ?? payload
      return matches(cached, span ?? trace) ? cached : undefined
    },
    async span(summary: SpanOverview, trace: TraceOverview, signal: AbortSignal): Promise<Span> {
      if (snapshot) {
        const span = snapshot.spans.find(span => span.id === summary.id)
        if (!span) throw new Error("Span is not present in this snapshot.")
        return span
      }
      const cached = spans.get(summary.id)
      if (trace.status !== "running" && current(cached, summary)) return cached!
      const value = await tracerApi.traces.span(traceId, summary.id, signal)
      signal.throwIfAborted()
      spans.set(summary.id, value)
      return value
    },
    async payload(trace: TraceOverview, signal: AbortSignal): Promise<TraceSummary> {
      if (snapshot) return snapshot
      if (current(payload, trace)) return payload!
      const value = await tracerApi.traces.payload(traceId, signal)
      signal.throwIfAborted()
      payload = value
      return value
    },
    async full(trace: TraceOverview, signal: AbortSignal): Promise<TraceDetail> {
      if (snapshot) return snapshot
      const [root, allSpans, scores] = await Promise.all([
        this.payload(trace, signal),
        readAllTracePages(options => tracerApi.traces.spans(traceId, options), signal),
        readAllTracePages(options => tracerApi.traces.scores(traceId, options), signal),
      ])
      for (const span of allSpans) spans.set(span.id, span)
      return { ...root, spans: allSpans, scores, spanStats: trace.spanStats, nextSpanCursor: null, nextScoreCursor: null }
    },
  }
}
export type TraceDetailLoader = ReturnType<typeof createTraceDetailLoader>

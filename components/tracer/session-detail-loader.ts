import type { TraceOverview } from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import { readAllTracePages } from "./trace-detail-loader"
import { sessionConversation, type ConversationTrace } from "@/src/lib/tracer/session-conversation"

/** Fetch complete conversation evidence only when the session Overview opens.
 * Completed traces are cached for this session; running traces stay fresh. */
export function createSessionConversationLoader() {
  const cache = new Map<string, { revision: string; trace: ConversationTrace }>()
  return async (traces: TraceOverview[], signal: AbortSignal) => {
    const details: ConversationTrace[] = []
    for (let offset = 0; offset < traces.length; offset += 4) {
      signal.throwIfAborted()
      details.push(...await Promise.all(traces.slice(offset, offset + 4).map(async trace => {
        const revision = JSON.stringify([trace.status, trace.endedAt, trace.spans])
        const cached = cache.get(trace.id)
        if (trace.status !== "running" && cached?.revision === revision) return cached.trace
        const [payload, spans] = await Promise.all([
          tracerApi.traces.payload(trace.id, signal),
          readAllTracePages(options => tracerApi.traces.spans(trace.id, options), signal),
        ])
        signal.throwIfAborted()
        const detail = { ...payload, spans }
        cache.set(trace.id, { revision, trace: detail })
        return detail
      })))
    }
    signal.throwIfAborted()
    return sessionConversation(details)
  }
}

/** Read all navigation summaries; individual payloads stay lazy in the inspector. */
export async function loadSessionOverview(sessionId: string, signal: AbortSignal) {
  const [session, summaries] = await Promise.all([
    tracerApi.sessions.get(sessionId, signal),
    readAllTracePages(options => tracerApi.traces.list({ ...options, sessionId }), signal),
  ])
  const traces: TraceOverview[] = []
  // Bound fan-out for long sessions instead of requesting every trace at once.
  for (let offset = 0; offset < summaries.length; offset += 4) {
    signal.throwIfAborted()
    traces.push(...await Promise.all(summaries.slice(offset, offset + 4).map(async trace => {
      const [overview, scores] = await Promise.all([
        tracerApi.traces.overview(trace.id, signal),
        readAllTracePages(options => tracerApi.traces.scores(trace.id, options), signal),
      ])
      return { ...overview, scores }
    })))
  }
  signal.throwIfAborted()
  traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
  return { session, traces }
}

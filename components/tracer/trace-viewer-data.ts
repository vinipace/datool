import type { Trace as ViewerTrace } from "@/components/ui/datool/trace-viewer/types"
import type {
  Span,
  TraceDetail,
  TraceOverview,
} from "@/src/lib/tracer/contracts"
import { spanTiming } from "./trace-inspector-data"

function toTuple(milliseconds: number): [number, number] {
  const normalized = Math.max(0, milliseconds)
  const seconds = Math.floor(normalized / 1000)
  return [seconds, Math.round((normalized - seconds * 1000) * 1_000_000)]
}

function statusCode(status: Span["status"]) {
  if (status === "errored") return 2
  if (status === "running" || status === "cancelled") return 0
  return 1
}

function kindCode(kind: Span["kind"]) {
  return {
    agent: 1,
    custom: 1,
    function: 1,
    llm: 3,
    score: 1,
    task: 3,
    tool: 3,
    workflow: 2,
  }[kind]
}

export function toViewerTrace(
  trace: TraceOverview | TraceDetail,
  now = Date.now()
): ViewerTrace {
  const spans = trace.spans.flatMap((span) => {
    // Scorer attempts can happen long after execution and must not stretch its timeline.
    if (span.kind === "score") return []
    const timing = spanTiming(span, now)
    if (!timing) return []

    return [
      {
        attributes: {
          ...span.attributes,
          ...("input" in span ? { "datool.span.input": span.input } : {}),
          ...("output" in span ? { "datool.span.output": span.output } : {}),
        },
        duration: toTuple(timing.end - timing.start),
        endTime: toTuple(timing.end),
        events: [],
        isRunning: span.status === "running",
        kind: kindCode(span.kind),
        library: { name: "datool" },
        links: [],
        name: span.name,
        parentSpanId: span.parentId ?? undefined,
        resource: span.kind,
        spanId: span.id,
        startTime: toTuple(timing.start),
        status: { code: statusCode(span.status) },
        traceFlags: 1,
      },
    ]
  })

  return {
    resources: Array.from(new Set(spans.map((span) => span.resource))).map(
      (name) => ({ attributes: {}, name })
    ),
    rootSpanId: spans.find((span) => !span.parentSpanId)?.spanId,
    spans,
    traceId: trace.id,
  }
}

export function runTimelineKey(traceId: string, spanId: string | null) {
  return encodeURIComponent(JSON.stringify([traceId, spanId]))
}

/** Preserve independent roots and namespace span IDs across every captured trace. */
export function toViewerRun(traces: TraceOverview[], now = Date.now()) {
  const targets = new Map<string, { traceId: string; spanId: string | null }>()
  const spans: ViewerTrace["spans"] = []
  for (const trace of traces) {
    const key = (spanId: string | null) => runTimelineKey(trace.id, spanId)
    const rootId = key(null)
    const timing = spanTiming(trace, now)
    const rootKind = trace.group?.type ?? "custom"
    if (timing) {
      spans.push({
        spanId: rootId,
        name: trace.name,
        resource: rootKind,
        kind: kindCode(rootKind),
        attributes: trace.attributes,
        library: { name: "datool" },
        links: [],
        events: [],
        startTime: toTuple(timing.start),
        endTime: toTuple(timing.end),
        duration: toTuple(timing.end - timing.start),
        status: { code: statusCode(trace.status) },
        traceFlags: 1,
        isRunning: trace.status === "running",
      })
      targets.set(rootId, { traceId: trace.id, spanId: null })
    }
    const captured = toViewerTrace(trace, now).spans
    const ids = new Set(captured.map((span) => span.spanId))
    for (const span of captured) {
      const id = key(span.spanId)
      spans.push({
        ...span,
        spanId: id,
        parentSpanId:
          span.parentSpanId && ids.has(span.parentSpanId)
            ? key(span.parentSpanId)
            : timing
              ? rootId
              : undefined,
      })
      targets.set(id, { traceId: trace.id, spanId: span.spanId })
    }
  }
  return {
    targets,
    trace: {
      traceId: traces.map((trace) => trace.id).join(","),
      spans,
      resources: [...new Set(spans.map((span) => span.resource))].map(
        (name) => ({ name, attributes: {} })
      ),
    } satisfies ViewerTrace,
  }
}

import { buildInspectorTree, type InspectorTreeNode } from "@/src/lib/tracer/trace-tree"
export { buildInspectorTree, type InspectorTreeNode } from "@/src/lib/tracer/trace-tree"
import type {
  Span,
  TraceOverview,
  TraceDetail,
  TraceStatus,
} from "@/src/lib/tracer/contracts"

export { normaliseChatMessages, normaliseOutputMessages, type InspectorMessage, type InspectorToolCall } from "@/src/lib/tracer/value-messages"

export type InspectorTreeRow = {
  node: InspectorTreeNode
  isLastChild: boolean
  continuingDepths: number[]
}

/** Trace identity scopes both selection and collapse, even when span IDs repeat. */
export function inspectorNodeKey(traceId: string, spanId: string | null) {
  return JSON.stringify([traceId, spanId])
}

export function flattenInspectorForest(traces: TraceOverview[], collapsed: ReadonlySet<string>, preserveTraceRoots = false) {
  return traces.flatMap(trace => {
    const localCollapsed = new Set<string>()
    if (collapsed.has(inspectorNodeKey(trace.id, null))) localCollapsed.add("__trace__")
    for (const span of trace.spans) {
      if (collapsed.has(inspectorNodeKey(trace.id, span.id))) localCollapsed.add(span.id)
    }
    return flattenInspectorTree(buildInspectorTree(trace, preserveTraceRoots), localCollapsed).map(row => ({
      ...row, trace, collapsed: localCollapsed, key: inspectorNodeKey(trace.id, row.node.id),
    }))
  })
}

/** Session children always retain a trace row, even for a single root span. */
export function flattenSessionTraces(traces: TraceOverview[], collapsed: ReadonlySet<string>) {
  const lastTraceId = traces.at(-1)?.id
  return flattenInspectorForest(traces, collapsed, true).map(row => ({
    ...row,
    node: { ...row.node, depth: row.node.depth + 1 },
    isLastChild: row.node.depth === 0 ? row.trace.id === lastTraceId : row.isLastChild,
    continuingDepths: [
      ...(row.node.depth > 0 && row.trace.id !== lastTraceId ? [1] : []),
      ...row.continuingDepths.map(depth => depth + 1),
    ],
  }))
}

/** Keep preorder and branch guides when only a window of the tree is mounted. */
export function flattenInspectorTree(root: InspectorTreeNode, collapsed: ReadonlySet<string>): InspectorTreeRow[] {
  const rows: InspectorTreeRow[] = []
  const stack: InspectorTreeRow[] = [{ node: root, isLastChild: true, continuingDepths: [] }]
  while (stack.length) {
    const row = stack.pop()!
    rows.push(row)
    if (collapsed.has(row.node.id ?? "__trace__")) continue
    const continuingDepths = row.node.depth > 0 && !row.isLastChild
      ? [...row.continuingDepths, row.node.depth]
      : row.continuingDepths
    for (let index = row.node.children.length - 1; index >= 0; index--) {
      stack.push({ node: row.node.children[index], isLastChild: index === row.node.children.length - 1, continuingDepths })
    }
  }
  return rows
}

export type InspectorTiming = {
  end: number
  start: number
}

export type InspectorTimelineRange = {
  end: number
  start: number
}

function timestamp(value: string | null | undefined) {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function spanTiming(
  span: Pick<Span, "durationMs" | "endedAt" | "startedAt" | "status">,
  now = Date.now()
): InspectorTiming | null {
  const start = timestamp(span.startedAt)
  if (start === null) return null

  const explicitEnd = timestamp(span.endedAt)
  const derivedEnd =
    span.durationMs === null ? null : Math.max(start, start + span.durationMs)
  const end =
    explicitEnd ?? derivedEnd ?? (span.status === "running" ? now : null)
  if (end === null) return null

  return { end: Math.max(start, end), start }
}

export function traceTimelineRange(
  trace: TraceOverview,
  now = Date.now()
): InspectorTimelineRange | null {
  const intervals = trace.spans
    .map((span) => spanTiming(span, now))
    .filter((interval): interval is InspectorTiming => interval !== null)
  const traceStart = timestamp(trace.startedAt)
  const traceEnd =
    timestamp(trace.endedAt) ??
    (traceStart === null
      ? null
      : trace.durationMs === null
        ? trace.status === "running"
          ? now
          : null
        : traceStart + trace.durationMs)

  if (traceStart !== null && traceEnd !== null) {
    intervals.push({ end: Math.max(traceStart, traceEnd), start: traceStart })
  }
  if (intervals.length === 0) return null

  const start = Math.min(...intervals.map((interval) => interval.start))
  const end = Math.max(...intervals.map((interval) => interval.end))
  return { end: Math.max(start + 1, end), start }
}

export function isTerminalStatus(status: TraceStatus) {
  return status !== "running"
}

export function compactRelativeTime(
  value: string | null | undefined,
  now = Date.now()
) {
  const valueTime = timestamp(value)
  if (valueTime === null) return "time unavailable"

  const elapsedSeconds = Math.max(0, Math.floor((now - valueTime) / 1000))
  if (elapsedSeconds < 10) return "just now"
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`

  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function knownDuration(durationMs: number | null, status: TraceStatus) {
  if (durationMs === null) {
    return isTerminalStatus(status) ? "Duration unavailable" : "Running"
  }
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000)
    return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 1 : 2)}s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`
}

export function toReadableJson(value: unknown) {
  try {
    const serialised = JSON.stringify(value, null, 2)
    return serialised === undefined ? "undefined" : serialised
  } catch {
    return "[unserializable value]"
  }
}

export function selectedRaw(trace: TraceDetail, spanId: string | null) {
  return spanId === null
    ? trace
    : (trace.spans.find((span) => span.id === spanId) ?? trace)
}

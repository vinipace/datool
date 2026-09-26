import type {
  JsonObject,
  JsonValue,
  TraceSpanStats,
  TraceStatus,
  TraceSummary,
} from "@/src/lib/tracer/contracts"
import { stringifyJson } from "./format"
import type { FixedFilter } from "@/components/ui/datool/search-bar"

export const TRACE_FIXED_FILTERS: readonly FixedFilter[] = [
  { field: "startedAt", defaultExpression: "startedAt >= -3d" },
]

export type TraceListColumnId =
  | "created"
  | "name"
  | "input"
  | "output"
  | "tags"
  | "duration"
  | "llmDuration"
  | "llmCalls"
  | "toolCalls"
  | "errors"
  | "models"
  | "inputTokens"
  | "outputTokens"
  | "cost"

export type TraceListColumn = {
  id: TraceListColumnId
  label: string
  minWidth: number
}

export const TRACE_LIST_COLUMNS: TraceListColumn[] = [
  { id: "created", label: "Created", minWidth: 164 },
  { id: "name", label: "Name", minWidth: 210 },
  { id: "input", label: "Input", minWidth: 230 },
  { id: "output", label: "Output", minWidth: 230 },
  { id: "tags", label: "Tags", minWidth: 174 },
  { id: "duration", label: "Duration", minWidth: 116 },
  { id: "llmDuration", label: "LLM duration", minWidth: 138 },
  { id: "llmCalls", label: "LLM calls", minWidth: 108 },
  { id: "toolCalls", label: "Tool calls", minWidth: 108 },
  { id: "errors", label: "Span errors", minWidth: 108 },
  { id: "models", label: "Models", minWidth: 220 },
  { id: "inputTokens", label: "Input tokens", minWidth: 125 },
  { id: "outputTokens", label: "Output tokens", minWidth: 125 },
  { id: "cost", label: "Estimated cost", minWidth: 150 },
]

export const DEFAULT_TRACE_LIST_COLUMNS = TRACE_LIST_COLUMNS.map(
  (column) => column.id
)

export type TraceTimeRange = "1h" | "24h" | "3d" | "7d" | "all"

export const TRACE_TIME_RANGES: Array<{
  id: TraceTimeRange
  label: string
  milliseconds: number | null
}> = [
  { id: "1h", label: "Past hour", milliseconds: 60 * 60 * 1_000 },
  { id: "24h", label: "Past 24 hours", milliseconds: 24 * 60 * 60 * 1_000 },
  { id: "3d", label: "Past 3 days", milliseconds: 3 * 24 * 60 * 60 * 1_000 },
  { id: "7d", label: "Past 7 days", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  { id: "all", label: "All loaded time", milliseconds: null },
]

export type TraceTableAggregates = {
  durationP50: number | null
  errors: MetricAggregate
  llmCalls: MetricAggregate
  llmDuration: MetricAggregate
  toolCalls: MetricAggregate
  traceCount: number
}

export type MetricAggregate = {
  complete: boolean
  knownCount: number
  rowCount: number
  total: number | null
}

export type HistogramBin = {
  count: number
  end: number
  start: number
}

const KNOWN_TAG_ATTRIBUTE_KEYS = [
  "deployment.environment",
  "demo",
  "demo.workflow",
  "environment",
  "service.name",
  "service.namespace",
  "source",
] as const

function asFiniteNonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function asFiniteNonNegativeInteger(value: unknown) {
  const number = asFiniteNonNegativeNumber(value)
  return number !== null && Number.isInteger(number) ? number : null
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function traceTimestamp(trace: TraceSummary) {
  const timestamp = new Date(trace.startedAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function numberToTagValue(value: string | number | boolean) {
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

export function getTraceSpanStats(trace: TraceSummary): TraceSpanStats | null {
  const stats = trace.spanStats
  if (!isJsonObject(stats)) return null

  const spanCount = asFiniteNonNegativeInteger(stats.spanCount)
  const llmCalls = asFiniteNonNegativeInteger(stats.llmCalls)
  const toolCalls = asFiniteNonNegativeInteger(stats.toolCalls)
  const errorCount = asFiniteNonNegativeInteger(stats.errorCount)
  const llmDurationMs =
    stats.llmDurationMs === null
      ? null
      : asFiniteNonNegativeNumber(stats.llmDurationMs)

  if (
    spanCount === null ||
    llmCalls === null ||
    toolCalls === null ||
    errorCount === null ||
    (stats.llmDurationMs !== null && llmDurationMs === null)
  ) {
    return null
  }

  return { errorCount, llmCalls, llmDurationMs, spanCount, toolCalls }
}

export function getTraceTags(attributes: JsonObject) {
  const tags: Array<{ key: string; value: string }> = []
  const attributeTags = attributes.tags

  if (Array.isArray(attributeTags)) {
    for (const value of attributeTags) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        tags.push({ key: "tag", value: numberToTagValue(value) })
      }
    }
  }

  for (const key of KNOWN_TAG_ATTRIBUTE_KEYS) {
    const value = attributes[key]
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      tags.push({ key, value: numberToTagValue(value) })
    }
  }

  const seen = new Set<string>()
  return tags.filter((tag) => {
    const signature = `${tag.key}:${tag.value}`
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}

export function formatTraceTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
  }).format(date)
}

export function formatCompactDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—"
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`

  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

export function formatTraceDuration(trace: TraceSummary) {
  if (trace.durationMs !== null) return formatCompactDuration(trace.durationMs)
  return trace.status === "running" ? "Running" : "—"
}

export function formatCount(value: number | null | undefined) {
  return value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat().format(value)
}

export function statusLabel(status: TraceStatus) {
  return status.replaceAll("-", " ")
}

export function filterTraces({
  now,
  query,
  status,
  timeRange,
  traces,
}: {
  now: number
  query: string
  status: "all" | TraceStatus
  timeRange: TraceTimeRange
  traces: TraceSummary[]
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const range = TRACE_TIME_RANGES.find(
    (candidate) => candidate.id === timeRange
  )
  const cutoff =
    range?.milliseconds === null || range?.milliseconds === undefined
      ? null
      : now - range.milliseconds

  return traces.filter((trace) => {
    const timestamp = traceTimestamp(trace)
    if (timestamp === null || timestamp > now) return false
    if (cutoff !== null && timestamp < cutoff) return false
    if (status !== "all" && trace.status !== status) return false
    if (!normalizedQuery) return true

    const searchable = [
      trace.id,
      trace.name,
      trace.operation,
      trace.status,
      trace.sessionId ?? "",
      stringifyJson(trace.input, 0),
      stringifyJson(trace.output, 0),
      stringifyJson(trace.attributes, 0),
    ]
      .join(" ")
      .toLocaleLowerCase()

    return searchable.includes(normalizedQuery)
  })
}

function median(values: number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

function aggregateOptionalMetric(
  traces: TraceSummary[],
  value: (stats: TraceSpanStats) => number | null
): MetricAggregate {
  let knownCount = 0
  let total = 0

  for (const trace of traces) {
    const stats = getTraceSpanStats(trace)
    const next = stats ? value(stats) : null
    if (next === null) continue
    total += next
    knownCount += 1
  }

  return {
    complete: knownCount === traces.length,
    knownCount,
    rowCount: traces.length,
    total: knownCount > 0 ? total : null,
  }
}

export function getTraceTableAggregates(
  traces: TraceSummary[]
): TraceTableAggregates {
  return {
    durationP50: median(
      traces.flatMap((trace) =>
        trace.endedAt !== null &&
        trace.status !== "running" &&
        typeof trace.durationMs === "number" &&
        Number.isFinite(trace.durationMs) &&
        trace.durationMs >= 0
          ? [trace.durationMs]
          : []
      )
    ),
    errors: aggregateOptionalMetric(traces, (stats) => stats.errorCount),
    llmCalls: aggregateOptionalMetric(traces, (stats) => stats.llmCalls),
    llmDuration: aggregateOptionalMetric(
      traces,
      (stats) => stats.llmDurationMs
    ),
    toolCalls: aggregateOptionalMetric(traces, (stats) => stats.toolCalls),
    traceCount: traces.length,
  }
}

export function formatAggregate(
  aggregate: MetricAggregate,
  suffix = "sum",
  format = formatCount
) {
  if (aggregate.total === null) return "—"
  const captured = aggregate.complete
    ? ""
    : ` · ${aggregate.knownCount}/${aggregate.rowCount} captured`
  return `${format(aggregate.total)} ${suffix}${captured}`
}

export function buildHistogram({
  now,
  timeRange,
  traces,
}: {
  now: number
  timeRange: TraceTimeRange
  traces: TraceSummary[]
}): HistogramBin[] {
  const timestamps = traces.flatMap((trace) => {
    const timestamp = traceTimestamp(trace)
    return timestamp === null ? [] : [timestamp]
  })
  const range = TRACE_TIME_RANGES.find(
    (candidate) => candidate.id === timeRange
  )
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : now
  const start =
    range?.milliseconds === null || range?.milliseconds === undefined
      ? earliest
      : now - range.milliseconds
  const end = now
  const duration = Math.max(end - start, 1)
  const binCount = 30
  const width = duration / binCount
  const bins = Array.from({ length: binCount }, (_, index) => ({
    count: 0,
    end: start + width * (index + 1),
    start: start + width * index,
  }))

  for (const timestamp of timestamps) {
    if (timestamp < start || timestamp > end) continue
    const index = Math.min(
      binCount - 1,
      Math.floor((timestamp - start) / width)
    )
    bins[index].count += 1
  }

  return bins
}

function csvValue(value: JsonValue | null | undefined) {
  const content =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : stringifyJson(value, 0)
  return `"${content.replaceAll('"', '""')}"`
}

export function tracesToCsv(traces: TraceSummary[]) {
  const headers = [
    "id",
    "created_at",
    "status",
    "name",
    "operation",
    "session_id",
    "input",
    "output",
    "attributes",
    "duration_ms",
    "span_count",
    "llm_duration_ms",
    "llm_calls",
    "tool_calls",
    "span_error_count",
  ]
  const rows = traces.map((trace) => {
    const stats = getTraceSpanStats(trace)
    return [
      trace.id,
      trace.startedAt,
      trace.status,
      trace.name,
      trace.operation,
      trace.sessionId ?? "",
      trace.input,
      trace.output,
      trace.attributes,
      trace.durationMs ?? "",
      stats?.spanCount ?? "",
      stats?.llmDurationMs ?? "",
      stats?.llmCalls ?? "",
      stats?.toolCalls ?? "",
      stats?.errorCount ?? "",
    ]
      .map((value) => csvValue(value as JsonValue | null))
      .join(",")
  })

  return `${headers.join(",")}\n${rows.join("\n")}`
}

export function downloadTraceExport({
  content,
  filename,
  type,
}: {
  content: string
  filename: string
  type: string
}) {
  const objectUrl = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement("a")
  anchor.download = filename
  anchor.href = objectUrl
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

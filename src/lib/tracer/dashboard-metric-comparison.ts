import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticMemberAnnotation } from "@/src/lib/semantic/result"

export type MetricTrendDirection = "increase" | "decrease" | "neutral"

// Display defaults for registered measures. Volume and arbitrary scores have no
// inherent good direction; a dashboard can explicitly choose its own goal.
const decreasingMeasures = new Set([
  "evalClassification.costUsd",
  "evalClassification.meanCostUsd",
  ...["spans", "traces"].flatMap((model) =>
    [
      "erroredCount",
      "errorRate",
      "meanDurationMs",
      "p95DurationMs",
      "meanTtftMs",
      "p95TtftMs",
      "costUsd",
      "inputCostUsd",
      "outputCostUsd",
      "cacheCostUsd",
    ].map((key) => `${model}.${key}`)
  ),
  "evalResults.errorCount",
  "evalResults.errorRate",
  "evalResults.explicitFailCount",
  "logs.erroredCount",
  "logs.errorRate",
  "logs.meanLatencyMs",
  "logs.p95LatencyMs",
  "logs.meanTtftMs",
  "logs.p95TtftMs",
  "logs.costUsd",
  "logs.inputCostUsd",
  "logs.outputCostUsd",
  "logs.cacheCostUsd",
  "traces.erroredCount",
  "traces.errorRate",
  "traces.meanDurationMs",
  "traces.p95DurationMs",
  "traces.reportedCostUsd",
  "scores.errorCount",
  "scores.explicitFailCount",
  ...["agents", "workflows"].flatMap((model) =>
    [
      "erroredCount",
      "errorRate",
      "meanDurationMs",
      "p95DurationMs",
      "reportedCostUsd",
    ].map((key) => `${model}.${key}`)
  ),
])
const increasingMeasures = new Set([
  "traces.completedCount",
  "agents.completedCount",
  "workflows.completedCount",
  "evalResults.explicitPassCount",
  "evalResults.explicitPassRate",
  "scores.explicitPassCount",
  "scores.explicitPassRate",
])

export function defaultMetricTrendDirection(
  member: string
): MetricTrendDirection {
  if (decreasingMeasures.has(member)) return "decrease"
  if (increasingMeasures.has(member)) return "increase"
  return "neutral"
}

/** Adjacent, half-open, equal-duration windows; never change the cohort. */
export function previousPeriodQuery(
  query: NormalizedSemanticQuery
): NormalizedSemanticQuery {
  return {
    ...query,
    timeDimensions: query.timeDimensions.map((time) => {
      const from = Date.parse(time.dateRange[0])
      const to = Date.parse(time.dateRange[1])
      return {
        ...time,
        dateRange: [
          new Date(from - (to - from)).toISOString(),
          new Date(from).toISOString(),
        ],
      }
    }),
  }
}

export function isPercentageMetric(annotation?: SemanticMemberAnnotation) {
  return (
    annotation?.format === "percent" ||
    annotation?.format === "percentage" ||
    annotation?.name.endsWith(".errorRate") ||
    annotation?.name === "scores.explicitPassRate"
  )
}

export function metricDelta(
  current: unknown,
  previous: unknown,
  direction: MetricTrendDirection
) {
  if (typeof current !== "number" || !Number.isFinite(current))
    return { available: false as const, reason: "No current data" }
  if (typeof previous !== "number" || !Number.isFinite(previous))
    return { available: false as const, reason: "No previous data" }
  const absolute = current - previous
  if (!Number.isFinite(absolute))
    return { available: false as const, reason: "Comparison unavailable" }
  const relative = previous === 0 ? null : absolute / Math.abs(previous)
  const trend = absolute === 0 ? "flat" : absolute > 0 ? "up" : "down"
  const tone =
    absolute === 0 || direction === "neutral"
      ? "neutral"
      : absolute > 0 === (direction === "increase")
        ? "positive"
        : "negative"
  return {
    available: true as const,
    absolute,
    relative:
      relative !== null && Number.isFinite(relative * 100) ? relative : null,
    trend,
    tone,
  } as const
}

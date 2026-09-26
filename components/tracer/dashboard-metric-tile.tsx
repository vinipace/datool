import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import {
  defaultMetricTrendDirection,
  isPercentageMetric,
  metricDelta,
} from "@/src/lib/tracer/dashboard-metric-comparison"
import { MetricDelta } from "@/components/ui/metric-delta"
import {
  dashboardCurrencyFormatter,
  formatDashboardValue,
} from "./dashboard-utils"
import { DashboardMetricChart } from "./dashboard-metric-chart"

function signedChange(value: number, suffix: string) {
  const magnitude = Math.abs(value)
  const text =
    magnitude > 0 && magnitude < 0.01
      ? "<0.01"
      : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
          magnitude
        )
  return `${value < 0 ? "−" : "+"}${text}${suffix}`
}

export function DashboardMetricTile({
  widget,
  result,
  previous,
  history,
}: {
  widget: DashboardWidget
  result: SemanticResult
  previous?: SemanticResult | null
  history?: SemanticResult | null
}) {
  const measure = result.query.measures[0]
  const annotation = result.annotation.measures[measure]
  const current = result.data[0]?.[measure]
  const prior = previous?.data[0]?.[measure]
  const delta = metricDelta(
    current,
    prior,
    widget.trendDirection ?? defaultMetricTrendDirection(measure)
  )
  const range = previous?.query.timeDimensions[0]?.dateRange
  const formatDate = (date: string) =>
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: result.query.timezone,
    }).format(new Date(date))
  const periodLabel = range
    ? `${formatDate(range[0])} – ${formatDate(range[1])} (${result.query.timezone})`
    : undefined
  const percentage = isPercentageMetric(annotation)
  const label = !delta.available
    ? delta.reason
    : delta.trend === "flat"
      ? "No change"
      : percentage
        ? signedChange(delta.absolute * 100, " pp")
        : delta.relative === null
          ? `${delta.absolute > 0 ? "+" : "−"}${formatDashboardValue(Math.abs(delta.absolute), annotation, "compact")}`
          : signedChange(delta.relative * 100, "%")
  return (
    <div className="flex h-full min-h-0 flex-col pt-3">
      <p
        className="shrink-0 px-4 text-4xl font-semibold tracking-tight tabular-nums"
        title={formatDashboardValue(current, annotation)}
      >
        {annotation?.currency && typeof current === "number"
          ? dashboardCurrencyFormatter(annotation.currency)
              .formatToParts(current)
              .map((part, index) =>
                part.type === "decimal" || part.type === "fraction" ? (
                  <span key={index} className="text-2xl text-muted-foreground">
                    {part.value}
                  </span>
                ) : (
                  part.value
                )
              )
          : formatDashboardValue(current, annotation, "compact")}
      </p>
      <div className="mt-3 shrink-0 px-4 text-xs">
        <MetricDelta
          trend={delta.available ? delta.trend : undefined}
          tone={delta.available ? delta.tone : "neutral"}
          tooltip={
            <div className="space-y-1">
              <p>
                {annotation?.title}
                {annotation?.estimated ? " · Estimated" : ""}
              </p>
              <p>
                {typeof prior === "number" && Number.isFinite(prior)
                  ? `Previous: ${formatDashboardValue(prior, annotation)}`
                  : "No previous data"}
              </p>
              {periodLabel && <p>{periodLabel}</p>}
              {percentage && delta.available && delta.trend !== "flat" && (
                <p>Change in percentage points.</p>
              )}
            </div>
          }
        >
          {label}
        </MetricDelta>
      </div>
      {history && typeof current === "number" && Number.isFinite(current) && (
        <DashboardMetricChart title={widget.title} result={history} />
      )}
    </div>
  )
}

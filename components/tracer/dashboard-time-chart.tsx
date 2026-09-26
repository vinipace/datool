"use client"
import { useId } from "react"
import {
  Area,
  ComposedChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { formatDashboardValue } from "./dashboard-utils"
import { dashboardChartGaps } from "@/src/lib/tracer/dashboard-chart-gaps"
import { dashboardMetricHistory } from "@/src/lib/tracer/dashboard-metric-history"
import { DashboardGapLines } from "./dashboard-gap-lines"
import { groupedTimeChart } from "@/src/lib/tracer/dashboard-time-series"

import {
  dashboardChartStyle,
  lineSeriesColor,
  seriesColor,
} from "./dashboard-chart-style"

export function DashboardTimeChart({
  widget: sourceWidget,
  result: sourceResult,
  summary: sourceSummary,
  stackGroups,
  missingLabel = "No data",
}: {
  widget: DashboardWidget
  result: SemanticResult
  summary: SemanticResult | null
  stackGroups?: Record<string, string>
  missingLabel?: string
}) {
  const { widget, result, summary } = groupedTimeChart(
    sourceWidget,
    sourceResult,
    sourceSummary
  )
  const partial =
    sourceResult.query.offset > 0 ||
    (sourceResult.query.total && sourceResult.meta.page.total === undefined) ||
    (sourceResult.meta.page.total !== undefined &&
      sourceResult.meta.page.total > sourceResult.data.length)
  const gradientId = useId().replace(/:/g, "")
  const measures = widget.query.measures
  const series = widget.series ?? measures
  const time = result.query.timeDimensions[0]
  const annotations = result.annotation.measures
  const config = Object.fromEntries(
    series.map((member, index) => [
      `v${index}`,
      {
        label: annotations[member]?.title ?? member,
        color:
          widget.type === "line"
            ? lineSeriesColor(index)
            : seriesColor(member, index),
      },
    ])
  ) satisfies ChartConfig
  // Only complete an unfiltered, fully loaded calendar. A page or HAVING
  // threshold can omit observed buckets, which must not become missing data.
  const history =
    widget.type === "line" &&
    time.granularity === "day" &&
    result.data.length > 0 &&
    !result.query.having?.length &&
    result.query.offset === 0 &&
    result.meta.page.total === result.data.length
      ? series.map((member) => dashboardMetricHistory(result, member))
      : null
  const rows = history
    ? history[0].map((row, rowIndex) => ({
        bucket: row.date,
        ...Object.fromEntries(
          history.map((values, index) => [`v${index}`, values[rowIndex].value])
        ),
      }))
    : result.data.map((row) => ({
        bucket: row[time.dimension],
        ...Object.fromEntries(
          series.map((member, index) => [`v${index}`, row[member]])
        ),
      }))
  const { data, gaps } = dashboardChartGaps(
    rows,
    series.map((_, index) => `v${index}`)
  )
  const hasData = result.data.some((row) =>
    series.some((member) => typeof row[member] === "number")
  )
  const legendMeasures = measures.filter((member) =>
    result.data.some((row) => typeof row[member] === "number")
  )
  if (sourceResult.query.dimensions.length && summary) {
    legendMeasures.sort((left, right) => {
      const leftValue = summary.data[0]?.[left]
      const rightValue = summary.data[0]?.[right]
      return (
        (typeof rightValue === "number" ? rightValue : -Infinity) -
        (typeof leftValue === "number" ? leftValue : -Infinity)
      )
    })
  }
  const isTtft =
    series.length > 0 &&
    series.every((member) => /^(logs|spans)[.](mean|p95)TtftMs$/.test(member))
  const format = (
    value: unknown,
    member = series[0],
    presentation: "full" | "compact" = "full"
  ) => {
    if (annotations[member]?.unit === "ms" && typeof value === "number")
      return `${Number((value / 1000).toFixed(2))}s`
    return formatDashboardValue(value, annotations[member], presentation)
  }
  const axes = (
    <>
      <CartesianGrid
        vertical={false}
        strokeOpacity={dashboardChartStyle.gridOpacity}
      />
      <XAxis
        dataKey="bucket"
        axisLine={{ stroke: "var(--border)" }}
        tickLine={{ stroke: "var(--border)" }}
        tickMargin={8}
        tickFormatter={(value) =>
          new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
            month: "short",
            ...(time.granularity === "month"
              ? { year: "2-digit" as const }
              : { day: "numeric" as const }),
            timeZone: "UTC",
          })
        }
      />
      <YAxis
        width={annotations[series[0]]?.unit === "USD" ? 56 : 40}
        axisLine={false}
        tickLine={false}
        tickFormatter={(value) => format(value, series[0], "compact")}
        domain={
          !hasData
            ? [0, annotations[series[0]]?.unit === "ms" ? 1000 : 1]
            : [0, "auto"]
        }
      />
      <ChartTooltip
        content={({ payload, active, label }) => (
          <ChartTooltipContent
            active={active}
            label={label}
            payload={payload
              .filter(
                (item) =>
                  typeof item.value === "number" && Number.isFinite(item.value)
              )
              .sort((left, right) => Number(right.value) - Number(left.value))}
            labelFormatter={(_label, payload) =>
              String(payload[0]?.payload?.bucket ?? "").slice(
                0,
                time.granularity === "month" ? 7 : undefined
              )
            }
            formatter={(value, name) => {
              const member =
                series[Number(String(name).replace("v", ""))] ?? series[0]
              return (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: config[String(name)]?.color }}
                    />
                    {annotations[member]?.title}
                  </span>
                  <strong className="tabular-nums">
                    {value === null ? missingLabel : format(value, member)}
                  </strong>
                </div>
              )
            }}
          />
        )}
      />
    </>
  )
  return (
    <div className={`${dashboardChartStyle.bodyClassName} h-full`}>
      <div
        className="relative flex-1 shrink-0"
        style={{ minHeight: dashboardChartStyle.height }}
      >
        <ChartContainer
          config={config}
          className="absolute inset-0 aspect-auto h-full w-full text-[10px]"
          aria-label={`${widget.title} chart`}
          role="group"
        >
          {widget.type === "line" ? (
            <ComposedChart
              accessibilityLayer
              data={data}
              margin={{ top: 16, right: 12, left: 0, bottom: 8 }}
            >
              <defs>
                {series.map((member, index) => (
                  <linearGradient
                    key={member}
                    id={`${gradientId}-area-${index}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor={`var(--color-v${index})`}
                      stopOpacity={dashboardChartStyle.lineAreaOpacity}
                    />
                    <stop
                      offset="100%"
                      stopColor={`var(--color-v${index})`}
                      stopOpacity={0}
                    />
                  </linearGradient>
                ))}
              </defs>
              {axes}
              <DashboardGapLines
                gaps={gaps}
                color={(source) => `var(--color-${source})`}
              />
              {series.map((member, index) => (
                <Area
                  key={member}
                  dataKey={`v${index}`}
                  type="monotone"
                  baseValue={0}
                  stroke={`var(--color-v${index})`}
                  strokeWidth={2}
                  fill={`url(#${gradientId}-area-${index})`}
                  fillOpacity={1}
                  dot={{ r: 3, fill: `var(--color-v${index})` }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          ) : (
            <BarChart
              accessibilityLayer
              data={data}
              barCategoryGap={dashboardChartStyle.barCategoryGap}
              margin={{ top: 16, right: 12, left: 0, bottom: 8 }}
            >
              {axes}
              {series.map((member, index) => (
                <Bar
                  key={member}
                  dataKey={`v${index}`}
                  stackId={stackGroups?.[member] ?? "total"}
                  fill={`var(--color-v${index})`}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ChartContainer>
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-xs text-foreground-muted">
            {isTtft ? "No first-token timing recorded" : missingLabel}
          </div>
        )}
      </div>
      <div className={`${dashboardChartStyle.legendClassName} shrink-0`}>
        {partial && (
          <p className="text-foreground-muted" role="status">
            Showing a partial time series. Narrow the date range or filters to
            see all data.
          </p>
        )}
        {hasData &&
          legendMeasures.map((member) => {
            const index = series.indexOf(member)
            return (
              <div
                key={member}
                className="flex items-center justify-between gap-3"
              >
                <span className="flex items-center gap-2 text-foreground-muted">
                  <span
                    className="size-2 shrink-0"
                    style={{
                      background:
                        index < 0
                          ? "var(--data-series-total)"
                          : config[`v${index}`].color,
                    }}
                  />
                  {annotations[member]?.title ?? member}
                </span>
                {summary && (
                  <span className="font-medium tabular-nums">
                    {format(summary.data[0]?.[member], member)}
                  </span>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

"use client"

import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { Report } from "@/src/lib/tracer/reports"
import {
  reportPresentationResult,
  type ReportPresentation,
} from "@/src/lib/tracer/report-presentation"
import {
  dashboardCategoryColors,
  dashboardCategoryKey,
  dashboardSeriesColor,
} from "./dashboard-chart-style"

type Progression = NonNullable<
  ReportPresentation["sections"][number]["progression"]
>
export function ReportProgression({
  report,
  progression,
}: {
  report: Report
  progression: Progression
}) {
  const result = reportPresentationResult(report, progression.widgetId)
  const colors = dashboardCategoryColors(
    report.snapshot.positions.flatMap((position) => {
      const widget = report.config.widgets.find((w) => w.id === position.id)
      return widget && ["bar", "scatter"].includes(widget.type)
        ? position.cohorts.map(
            (cohort) => report.snapshot.results[cohort.result]
          )
        : []
    })
  )
  const rows = progression.stages.map((stage) => {
    const row = result.data.find(
      (row) => row[progression.dimension] === stage.value
    )!
    return {
      name: stage.label,
      primary: Number(row[progression.measures[0].member]),
      secondary: progression.measures[1]
        ? Number(row[progression.measures[1].member])
        : undefined,
      color: dashboardSeriesColor(
        colors.get(dashboardCategoryKey(row, [progression.dimension])) ?? 0
      ),
    }
  })
  const primary = progression.measures[0].label
  const secondary = progression.measures[1]?.label
  return (
    <div className="overflow-hidden rounded-xl bg-muted">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 text-xs text-foreground-muted sm:px-6">
        <span>Rate · %</span>
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-2">
            <span aria-hidden className="w-5 border-t-2 border-foreground" />
            {primary}
          </span>
          {secondary && (
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="w-5 border-t-2 border-dashed border-foreground-muted"
              />
              {secondary}
            </span>
          )}
        </div>
      </div>
      <ChartContainer
        config={{
          primary: { label: primary, color: "var(--foreground)" },
          secondary: { label: secondary, color: "var(--foreground-muted)" },
        }}
        className="mt-2 aspect-auto h-64 w-full text-xs sm:h-72"
        aria-label={`${primary}${secondary ? ` and ${secondary}` : ""} by version`}
      >
        <LineChart
          accessibilityLayer
          data={rows}
          margin={{ top: 28, right: 36, left: 0, bottom: 8 }}
        >
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 6"
            strokeOpacity={0.35}
          />
          <XAxis
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tickMargin={12}
            padding={{ left: 30, right: 16 }}
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={(value) => `${value * 100}%`}
            axisLine={false}
            tickLine={false}
            width={54}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                variant="surface"
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-6">
                    <span className="text-foreground-muted">{name}</span>
                    <span className="font-mono tabular-nums">
                      {(Number(value) * 100).toFixed(1)}%
                    </span>
                  </div>
                )}
              />
            }
          />
          {secondary && (
            <Line
              dataKey="secondary"
              name={secondary}
              stroke="var(--foreground-muted)"
              strokeDasharray="5 5"
              strokeWidth={1.5}
              dot={{ r: 3, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          )}
          <Line
            dataKey="primary"
            name={primary}
            stroke="var(--foreground)"
            strokeWidth={2}
            activeDot={{ r: 6, strokeWidth: 0 }}
            isAnimationActive={false}
            dot={({ cx, cy, payload }) => (
              <circle
                key={payload.name}
                cx={cx}
                cy={cy}
                r={5}
                fill={payload.color}
              />
            )}
          >
            <LabelList
              dataKey="primary"
              position="top"
              offset={12}
              formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`}
              fill="var(--foreground)"
              className="font-mono text-xs"
            />
          </Line>
        </LineChart>
      </ChartContainer>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border p-5 sm:grid-cols-4 sm:p-6">
        {progression.stages.map((stage, index) => (
          <div key={stage.value}>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: rows[index].color }}
                aria-hidden
              />
              {stage.label}
              <span className="text-foreground-muted">{stage.title}</span>
            </div>
            <p className="text-sm leading-relaxed text-foreground-muted">
              {stage.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

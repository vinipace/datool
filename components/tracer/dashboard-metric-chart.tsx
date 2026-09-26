"use client"

import { Area, ComposedChart, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { dashboardMetricHistory } from "@/src/lib/tracer/dashboard-metric-history"
import { dashboardChartGaps } from "@/src/lib/tracer/dashboard-chart-gaps"
import { DashboardGapLines } from "./dashboard-gap-lines"
import { dashboardChartStyle, metricSeriesColor } from "./dashboard-chart-style"
import { formatDashboardValue } from "./dashboard-utils"

export function DashboardMetricChart({
  title,
  result,
}: {
  title: string
  result: SemanticResult
}) {
  const measure = result.query.measures[0]
  const annotation = result.annotation.measures[measure]
  const { data, gaps } = dashboardChartGaps(dashboardMetricHistory(result), [
    "value",
  ])
  const color = metricSeriesColor(measure)
  if (!data.length) return null
  return (
    <ChartContainer
      config={{ value: { label: annotation?.title ?? measure } }}
      className="mt-3 aspect-auto min-h-14 w-full min-w-0 flex-1 rounded-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
      initialDimension={{ width: 160, height: 56 }}
      role="group"
      aria-label={`${title} daily values`}
    >
      <ComposedChart
        accessibilityLayer
        data={data}
        margin={{ top: 3, right: 0, bottom: 0, left: 0 }}
      >
        <XAxis dataKey="date" padding={{ left: 0, right: 0 }} hide />
        <YAxis hide />
        <ChartTooltip
          cursor={false}
          filterNull={false}
          isAnimationActive={false}
          position={{ y: 0 }}
          content={
            <ChartTooltipContent
              className="min-w-0"
              labelFormatter={(_label, payload) =>
                new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }).format(new Date(payload[0]?.payload.date))
              }
              formatter={(_value, _name, item) => (
                <span className="font-medium tabular-nums">
                  {item.payload.value === null
                    ? "No data"
                    : formatDashboardValue(item.payload.value, annotation)}
                </span>
              )}
            />
          }
        />
        <DashboardGapLines gaps={gaps} color={() => color} />
        <Area
          dataKey="value"
          type="monotone"
          baseValue={0}
          stroke={color}
          strokeWidth={2}
          strokeOpacity={dashboardChartStyle.metricLineOpacity}
          fill={color}
          fillOpacity={dashboardChartStyle.metricAreaOpacity}
          dot={
            data.length === 1 ? { r: 2, fill: color, strokeWidth: 0 } : false
          }
          activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  )
}

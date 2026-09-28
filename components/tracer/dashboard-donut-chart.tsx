"use client"

import { Pie, PieChart } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type {
  SemanticDataRow,
  SemanticMemberAnnotation,
} from "@/src/lib/semantic/result"
import {
  dashboardChartStyle,
  dashboardSeriesColor,
} from "./dashboard-chart-style"
import { formatDashboardValue } from "./dashboard-utils"
import { DashboardGroupLabel } from "./dashboard-dimension-label"
import { dashboardGroupText } from "./dashboard-dimension-icon"

export function DashboardDonutChart({
  title,
  rows,
  measure,
  dimensions,
  annotation,
  dimensionAnnotations,
  showGroupIcons = false,
  partial = false,
}: {
  title: string
  rows: SemanticDataRow[]
  measure: string
  dimensions: string[]
  dimensionAnnotations?: Record<string, SemanticMemberAnnotation>
  annotation?: SemanticMemberAnnotation
  showGroupIcons?: boolean
  partial?: boolean
}) {
  // Flatten semantic member names; Recharts interprets dots as object paths.
  const data = rows.map((row, index) => ({
    category: dimensionAnnotations
      ? dimensions
          .map((d) => formatDashboardValue(row[d], dimensionAnnotations[d]))
          .join(" · ")
      : dashboardGroupText(dimensions, row),
    group: row,
    value:
      typeof row[measure] === "number" && Number.isFinite(row[measure])
        ? row[measure]
        : null,
    fill: dashboardSeriesColor(index),
  }))
  const negative = data.some((row) => row.value !== null && row.value < 0)
  const missing = data.some((row) => row.value === null)
  const slices = data.filter((row) => row.value !== null && row.value > 0)
  const total = slices.reduce((sum, row) => sum + row.value!, 0)
  const showTotal =
    !missing &&
    (annotation?.aggregation === "sum" || annotation?.aggregation === "count")
  const config = {
    value: { label: annotation?.title ?? measure },
  } satisfies ChartConfig

  return (
    <div className={dashboardChartStyle.bodyClassName}>
      {negative || !total ? (
        <p className="py-10 text-center text-sm text-foreground-muted">
          {negative
            ? "Negative values cannot be shown in a donut chart. Use a bar chart."
            : "No positive values in this time range."}
        </p>
      ) : (
        <div className="relative">
          <ChartContainer
            config={config}
            className="aspect-auto h-56 w-full min-w-0 rounded-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
            aria-label={`${title} donut chart`}
            role="group"
          >
            <PieChart accessibilityLayer>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) =>
                      showGroupIcons ? (
                        <DashboardGroupLabel
                          dimensions={dimensions}
                          row={payload[0]?.payload?.group ?? {}}
                        />
                      ) : (
                        String(payload[0]?.payload?.category ?? "Not recorded")
                      )
                    }
                    formatter={(value, _name, item) => (
                      <div className="flex min-w-36 items-center justify-between gap-4">
                        <span className="flex items-center gap-2 text-foreground-muted">
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: item.payload?.fill }}
                          />
                          {annotation?.title ?? measure}
                        </span>
                        <span className="font-medium tabular-nums">
                          {formatDashboardValue(value, annotation)}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Pie
                data={slices}
                dataKey="value"
                nameKey="category"
                innerRadius="64%"
                outerRadius="90%"
                startAngle={90}
                endAngle={-270}
                paddingAngle={slices.length > 1 ? 3 : 0}
                cornerRadius={dashboardChartStyle.barRadius}
                stroke="none"
                isAnimationActive={false}
              />
            </PieChart>
          </ChartContainer>
          {showTotal && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1">
              <span className="text-3xl font-semibold text-foreground tabular-nums">
                {formatDashboardValue(total, annotation)}
              </span>
              <span className="text-xs text-foreground-muted">
                {partial ? "Shown total" : "Total"}
              </span>
            </div>
          )}
        </div>
      )}
      <div className={dashboardChartStyle.legendClassName}>
        {data.map((row, index) => (
          <div
            key={`${row.category}:${index}`}
            className="flex items-center justify-between gap-3"
          >
            <span
              className="flex min-w-0 items-center gap-2 text-foreground-muted"
              title={row.category}
            >
              <span
                className="size-2 shrink-0"
                style={{ background: row.fill }}
              />
              {showGroupIcons ? (
                <DashboardGroupLabel dimensions={dimensions} row={row.group} />
              ) : (
                <span className="truncate">{row.category}</span>
              )}
            </span>
            <span className="shrink-0 font-medium tabular-nums">
              {formatDashboardValue(row.value, annotation)}
            </span>
          </div>
        ))}
      </div>
      {(partial || missing) && (
        <p className="px-3 text-xs text-foreground-muted">
          {partial && "Shares reflect only the categories on this page. "}
          {missing && "Categories with no data are omitted from the ring."}
        </p>
      )}
    </div>
  )
}

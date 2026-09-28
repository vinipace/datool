"use client"

import {
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import {
  matchesReportHighlight,
  type ReportHighlight,
  type ReportReference,
} from "@/src/lib/tracer/report-highlights"
import { formatDashboardValue } from "./dashboard-utils"
import { DataAnnotationTooltip } from "@/components/ui/data-annotation"
import {
  dashboardCategoryColors,
  dashboardCategoryKey,
  dashboardChartStyle,
  dashboardSeriesColor,
} from "./dashboard-chart-style"

export function DashboardScatterChart({
  widget,
  result,
  highlights = [],
  references = [],
  categoryColors,
}: {
  widget: DashboardWidget
  result: SemanticResult
  highlights?: ReportHighlight[]
  references?: ReportReference[]
  categoryColors?: Map<string, number>
}) {
  const [x, y] = result.query.measures
  const annotations = {
    ...result.annotation.measures,
    ...result.annotation.dimensions,
  }
  const colors = categoryColors ?? dashboardCategoryColors([result])
  const rows = result.data
    .filter((row) => typeof row[x] === "number" && typeof row[y] === "number")
    .map((row) => ({
      x: row[x],
      y: row[y],
      color: dashboardSeriesColor(
        colors.get(dashboardCategoryKey(row, result.query.dimensions)) ?? 0
      ),
      name: result.query.dimensions
        .map((key) => formatDashboardValue(row[key], annotations[key]))
        .join(" · "),
      note: highlights
        .filter((h) => matchesReportHighlight(h, row))
        .map((h) => h.label)
        .join(" · "),
    }))
  if (!rows.length)
    return (
      <p className="py-10 text-center text-sm text-foreground-muted">
        No paired numeric values in this range.
      </p>
    )

  return (
    <div className={`${dashboardChartStyle.bodyClassName} h-full`}>
      <div className="relative min-h-52 flex-1 shrink-0">
        <ChartContainer
          config={{ point: { label: widget.title } }}
          className="absolute inset-0 aspect-auto h-full w-full text-[10px]"
          aria-label={`${widget.title} scatter plot`}
          role="group"
        >
          <ScatterChart
            accessibilityLayer
            margin={{ top: 28, right: 24, bottom: 28, left: 0 }}
          >
            <CartesianGrid
              vertical={false}
              strokeOpacity={dashboardChartStyle.gridOpacity}
            />
            <XAxis
              dataKey="x"
              type="number"
              name={annotations[x]?.title}
              domain={[0, "auto"]}
              tickCount={4}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatDashboardValue(v, annotations[x])}
              label={{
                value: annotations[x]?.title,
                position: "insideBottom",
                offset: -20,
                fill: "var(--foreground-muted)",
                fontSize: 11,
              }}
            />
            <YAxis
              dataKey="y"
              type="number"
              name={annotations[y]?.title}
              width={44}
              domain={[0, "auto"]}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => formatDashboardValue(v, annotations[y])}
            />
            <ZAxis range={[80, 80]} />
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => (
                <ChartTooltipContent
                  variant="surface"
                  active={active}
                  payload={payload}
                  label={payload?.[0]?.payload?.name}
                  formatter={(_, name, item) => {
                    const member = item.dataKey === "x" ? x : y
                    return (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-foreground-muted">{name}</span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatDashboardValue(
                            item.value,
                            annotations[member]
                          )}
                        </span>
                      </div>
                    )
                  }}
                />
              )}
            />
            {references.map((reference, index) => (
              <ReferenceLine
                key={index}
                {...(reference.measure === x
                  ? { x: reference.value }
                  : { y: reference.value })}
                stroke="var(--foreground-muted)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{
                  value: reference.label,
                  position: "insideTopRight",
                  fill: "var(--foreground-muted)",
                  fontSize: 11,
                }}
              />
            ))}
            <Scatter data={rows} isAnimationActive={false}>
              {rows.map((row, index) => (
                <Cell
                  key={index}
                  fill={row.color}
                  stroke="var(--muted)"
                  strokeWidth={1}
                />
              ))}
              <LabelList
                dataKey="name"
                position="top"
                offset={10}
                fill="var(--foreground-muted)"
                fontSize={11}
              />
            </Scatter>
          </ScatterChart>
        </ChartContainer>
      </div>
      <div className={`${dashboardChartStyle.legendClassName} shrink-0 pb-1`}>
        {rows.map((row, index) => (
          <DataAnnotationTooltip
            key={index}
            labels={row.note ? [row.note] : []}
          >
            <div className="flex items-center gap-2 text-foreground-muted">
              <span
                className="size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: row.color }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="font-mono text-foreground tabular-nums">
                {formatDashboardValue(row.x, annotations[x])}
              </span>
              <span className="w-16 text-right font-mono text-foreground tabular-nums">
                {formatDashboardValue(row.y, annotations[y])}
              </span>
            </div>
          </DataAnnotationTooltip>
        ))}
      </div>
    </div>
  )
}

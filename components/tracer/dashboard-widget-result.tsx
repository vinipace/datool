"use client"

import { usePathname } from "next/navigation"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { workspacePrefix } from "@/lib/workspace-routing"
import { dashboardTraceFilter } from "@/src/lib/tracer/dashboard-trace-links"

import { DashboardMetricTile } from "./dashboard-metric-tile"
import { Button } from "@/components/ui/button"
import {
  dashboardColumns,
  type DashboardWidget,
} from "@/src/lib/tracer/dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { DashboardBarChart } from "./dashboard-bar-chart"
import { DashboardDonutChart } from "./dashboard-donut-chart"
import { DashboardTimeChart } from "./dashboard-time-chart"
import { formatDashboardValue } from "./dashboard-utils"
import { isPercentageMetric } from "@/src/lib/tracer/dashboard-metric-comparison"
import { PercentageCell } from "./percentage-cell"
import { metricTone } from "./dashboard-chart-style"
import { DashboardDimensionLabel } from "./dashboard-dimension-label"
import { dashboardDimensionIcon } from "./dashboard-dimension-icon"

export function WidgetResult({
  widget,
  result,
  summary,
  previous,
  history,
  setOffset,
  colorIndex = 0,
}: {
  widget: DashboardWidget
  result: SemanticResult
  summary: SemanticResult | null
  previous?: SemanticResult | null
  history?: SemanticResult | null
  setOffset: (offset: number) => void
  colorIndex?: number
}) {
  const prefix = workspacePrefix(usePathname())
  const offset = result.query.offset
  const timeChart = widget.type === "stacked" || widget.type === "line"
  const columns = dashboardColumns(result.query)
  const annotations = {
    ...result.annotation.dimensions,
    ...result.annotation.timeDimensions,
    ...result.annotation.measures,
  }
  const measure = result.query.measures[0]
  const dimensions = columns.filter((c) => !result.query.measures.includes(c))
  const total = result.meta.page.total ?? result.data.length
  if (timeChart)
    return (
      <DashboardTimeChart widget={widget} result={result} summary={summary} />
    )
  return (
    <>
      {widget.type === "metric" ? (
        <DashboardMetricTile
          widget={widget}
          result={result}
          previous={previous}
          history={history}
        />
      ) : !result.data.length ? (
        <p className="py-10 text-center text-sm text-foreground-muted">
          No data in this time range.
        </p>
      ) : widget.type === "donut" && dimensions.length ? (
        <DashboardDonutChart
          title={widget.title}
          rows={result.data}
          measure={measure}
          dimensions={dimensions}
          annotation={annotations[measure]}
          showGroupIcons={widget.showGroupIcons}
          partial={
            offset > 0 ||
            result.meta.page.total === undefined ||
            total > result.data.length
          }
        />
      ) : widget.type === "bar" && dimensions.length ? (
        <DashboardBarChart
          colorIndex={colorIndex}
          hrefForRow={(row) => {
            // Name-based trace navigation cannot represent every grouped field.
            if (!prefix || dimensions.length !== 1) return
            const dimension = dimensions[0]
            const filter = dashboardTraceFilter(
              result.query,
              dimension,
              row[dimension]
            )
            return filter
              ? `${prefix}/traces?${new URLSearchParams({ filter })}`
              : undefined
          }}
          title={widget.title}
          rows={result.data}
          measure={measure}
          dimensions={dimensions}
          annotation={annotations[measure]}
          showGroupIcons={widget.showGroupIcons}
        />
      ) : (
        <div className="overflow-auto">
          <div className="px-2">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="relative after:absolute after:top-0 after:bottom-1 after:left-0 after:w-full after:rounded-md after:bg-surface-row-hover/80">
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="relative z-10 px-2 pt-3 pb-4 align-bottom text-sm font-medium text-foreground-muted"
                      title={annotations[c]?.description}
                    >
                      {annotations[c]?.title ?? c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="px-1 text-foreground">
                {result.data.map((row, index) => (
                  <tr
                    key={index}
                    className="relative after:absolute after:top-0 after:bottom-1 after:left-0 after:w-full after:rounded-md after:bg-surface-row-hover/50"
                  >
                    {columns.map((c) => (
                      <td
                        key={c}
                        className="relative z-10 px-2 py-2 tabular-nums"
                      >
                        <div className="flex min-h-8 items-center">
                          {widget.showGroupIcons &&
                          dashboardDimensionIcon(c) ? (
                            <DashboardDimensionLabel
                              dimension={c}
                              value={row[c]}
                            />
                          ) : isPercentageMetric(annotations[c]) &&
                            typeof row[c] === "number" ? (
                            <PercentageCell
                              value={row[c]}
                              tone={metricTone(c)}
                            />
                          ) : (
                            formatDashboardValue(row[c], annotations[c])
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {widget.type !== "metric" &&
        (offset > 0 || total > result.data.length) && (
          <div className="mt-3 flex items-center justify-between px-3 text-xs text-foreground-muted">
            <span>
              {total ? offset + 1 : 0}–
              {Math.min(offset + result.data.length, total)} of {total}
            </span>
            <div className="flex">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous"
                title="Previous"
                disabled={offset === 0}
                onClick={() =>
                  setOffset(Math.max(0, offset - result.query.limit))
                }
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Next"
                title="Next"
                disabled={offset + result.data.length >= total}
                onClick={() => setOffset(offset + result.query.limit)}
              >
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
    </>
  )
}

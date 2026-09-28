"use client"

import { DataAnnotationTooltip } from "@/components/ui/data-annotation"
import {
  matchesReportHighlight,
  type ReportHighlight,
  type ReportReference,
} from "@/src/lib/tracer/report-highlights"
import Link from "next/link"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { MetricDelta } from "@/components/ui/metric-delta"
import { metricDelta } from "@/src/lib/tracer/dashboard-metric-comparison"
import type { DashboardBarBaseline } from "@/src/lib/tracer/dashboard-bar-comparison"

import type {
  SemanticDataRow,
  SemanticMemberAnnotation,
} from "@/src/lib/semantic/result"
import {
  dashboardChartStyle,
  dashboardBarColor,
  dashboardCategoryKey,
  dashboardSeriesColor,
} from "./dashboard-chart-style"
import { formatDashboardValue } from "./dashboard-utils"
import { DashboardGroupLabel } from "./dashboard-dimension-label"
import { dashboardGroupText } from "./dashboard-dimension-icon"

function BarRow({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <Button
      asChild
      variant="ghost"
      className="relative block h-auto w-full p-0 text-left font-normal whitespace-normal hover:underline"
    >
      <Link href={href} prefetch={false}>
        {children}
      </Link>
    </Button>
  ) : (
    <div className="relative">{children}</div>
  )
}

export function DashboardBarChart({
  title,
  rows,
  measure,
  dimensions,
  annotation,
  showGroupIcons = false,
  colorIndex = 0,
  categoryColors,
  hrefForRow,
  highlights = [],
  references = [],
  dimensionAnnotations,
  baseline,
}: {
  baseline?: DashboardBarBaseline
  highlights?: ReportHighlight[]
  references?: ReportReference[]
  dimensionAnnotations?: Record<string, SemanticMemberAnnotation>
  title: string
  rows: SemanticDataRow[]
  measure: string
  dimensions: string[]
  annotation?: SemanticMemberAnnotation
  showGroupIcons?: boolean
  colorIndex?: number
  categoryColors?: Map<string, number>
  hrefForRow?: (row: SemanticDataRow) => string | undefined
}) {
  const categoryLabel = (row: SemanticDataRow) =>
    dimensionAnnotations
      ? dimensions
          .map((d) => formatDashboardValue(row[d], dimensionAnnotations[d]))
          .join(" · ")
      : dashboardGroupText(dimensions, row)
  const baselineLabel = baseline?.row
    ? categoryLabel(baseline.row)
    : baseline?.label
  const markers = references.length
    ? references
    : baseline
      ? [{ value: baseline.value, label: `Baseline ${baselineLabel}` }]
      : []
  const data = rows.map((row) => ({
    colorIndex:
      categoryColors?.get(dashboardCategoryKey(row, dimensions)) ?? colorIndex,
    category: categoryLabel(row),
    group: row,
    value: typeof row[measure] === "number" ? row[measure] : null,
    href: hrefForRow?.(row),
    isBaseline:
      baseline?.row &&
      dimensions.every(
        (dimension) => row[dimension] === baseline.row?.[dimension]
      ),
    delta: baseline
      ? metricDelta(row[measure], baseline.value, baseline.direction)
      : undefined,
  }))
  const values = data.flatMap((row) => (row.value === null ? [] : [row.value]))
  const minimum = Math.min(0, ...values, ...markers.map((r) => r.value))
  const maximum = Math.max(0, ...values, ...markers.map((r) => r.value))
  const range = maximum - minimum || 1
  const zero = (-minimum / range) * 100
  // Keep floating reference lines out of the values and their comparison labels.
  const valueGutter = baseline ? 96 : 0

  return (
    <div className={dashboardChartStyle.bodyClassName}>
      {baseline && (
        <p className="px-2 text-xs text-foreground-muted">
          Change vs {baselineLabel}
          {baseline.direction !== "neutral" &&
            ` · ${baseline.direction === "decrease" ? "Lower" : "Higher"} is better`}
        </p>
      )}
      <div
        role="group"
        aria-label={`${title} bar chart`}
        className="relative space-y-2.5 px-0 py-2"
        style={{ marginTop: markers.length ? 32 : undefined }}
      >
        {markers.map((reference, index) => {
          const position = ((reference.value - minimum) / range) * 100
          return (
            <div
              key={index}
              className="pointer-events-none absolute inset-y-0 z-20 border-l-2 border-dashed border-foreground"
              style={{
                left: `calc(${position}% - ${(valueGutter * position) / 100 + 1}px)`,
              }}
            >
              <span
                className="absolute -top-7 flex w-max max-w-64 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
                style={{
                  transform: position > 50 ? "translateX(-100%)" : undefined,
                }}
              >
                {reference.label}
                <span className="font-mono font-medium tabular-nums">
                  {formatDashboardValue(reference.value, annotation)}
                </span>
              </span>
            </div>
          )
        })}
        {data.map((row, index) => (
          <BarRow key={`${row.category}:${index}`} href={row.href}>
            <div className="relative inset-0 z-15 flex items-center justify-between gap-3 px-2 py-2 text-xs">
              <span
                className="flex min-w-0 items-center gap-2 text-foreground"
                title={row.category}
              >
                {categoryColors && (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-sm"
                    style={{
                      backgroundColor: dashboardSeriesColor(row.colorIndex),
                    }}
                  />
                )}
                <span className="min-w-0 truncate">
                  {showGroupIcons ? (
                    <DashboardGroupLabel
                      dimensions={dimensions}
                      row={row.group}
                    />
                  ) : (
                    row.category
                  )}
                </span>
              </span>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <DataAnnotationTooltip
                  labels={highlights
                    .filter((h) => matchesReportHighlight(h, row.group))
                    .map((h) => h.label)}
                >
                  <span
                    data-highlighted={
                      highlights.some((h) =>
                        matchesReportHighlight(h, row.group)
                      ) || undefined
                    }
                    className="shrink-0 font-mono font-medium tabular-nums data-[highlighted]:underline data-[highlighted]:decoration-dashed data-[highlighted]:underline-offset-4"
                  >
                    {formatDashboardValue(row.value, annotation)}
                  </span>
                </DataAnnotationTooltip>
                {row.delta &&
                  (row.isBaseline ? (
                    <span className="text-xs text-foreground-muted">
                      Baseline
                    </span>
                  ) : (
                    <DataAnnotationTooltip
                      tone={row.delta.available ? row.delta.tone : "neutral"}
                      labels={
                        row.delta.available
                          ? [
                              `${row.delta.absolute < 0 ? "−" : row.delta.absolute > 0 ? "+" : ""}${formatDashboardValue(Math.abs(row.delta.absolute), annotation)}`,
                            ]
                          : [row.delta.reason]
                      }
                    >
                      <span className="font-mono">
                        <MetricDelta
                          trend={
                            row.delta.available ? row.delta.trend : undefined
                          }
                          tone={
                            row.delta.available ? row.delta.tone : "neutral"
                          }
                        >
                          {!row.delta.available
                            ? "—"
                            : row.delta.relative === null
                              ? `${row.delta.absolute < 0 ? "−" : row.delta.absolute > 0 ? "+" : ""}${formatDashboardValue(Math.abs(row.delta.absolute), annotation)}`
                              : new Intl.NumberFormat("en-US", {
                                  style: "percent",
                                  signDisplay: "exceptZero",
                                  minimumFractionDigits: 1,
                                  maximumFractionDigits: 1,
                                }).format(row.delta.relative)}
                        </MetricDelta>
                        <span className="sr-only">
                          {" "}
                          compared with {baselineLabel}
                        </span>
                      </span>
                    </DataAnnotationTooltip>
                  ))}
              </div>
            </div>

            <div className="absolute inset-0 z-5 overflow-hidden rounded-md bg-surface-row-hover"></div>
            <div
              className="absolute inset-0 z-10 overflow-hidden rounded-md"
              aria-hidden="true"
              style={{ right: valueGutter }}
            >
              {minimum < 0 && (
                <span
                  className="absolute inset-y-0 border-l border-border"
                  style={{ left: `${zero}%` }}
                />
              )}
              {row.value !== null && (
                <span
                  className="absolute inset-y-0 rounded-md"
                  style={{
                    left: `${row.value < 0 ? ((row.value - minimum) / range) * 100 : zero}%`,
                    width: `${(Math.abs(row.value) / range) * 100}%`,
                    backgroundColor: categoryColors
                      ? dashboardSeriesColor(row.colorIndex)
                      : dashboardBarColor(row.colorIndex),
                    opacity: "var(--data-bar-opacity)",
                  }}
                />
              )}
            </div>
          </BarRow>
        ))}
      </div>
    </div>
  )
}

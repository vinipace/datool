"use client"

import { Check, Minus, X } from "lucide-react"
import { Notice } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import type { Report } from "@/src/lib/tracer/reports"
import type { ReportComparison as Comparison } from "@/src/lib/tracer/report-layout-contract"
import {
  reportComparisonRows,
  reportMetricChange,
  reportTargetStatus,
  reportBestValue,
} from "@/src/lib/tracer/report-layouts"
import { formatDashboardValue } from "./dashboard-utils"

export function ReportComparison({
  report,
  comparison,
  scorecard = false,
  title,
  description,
}: {
  report: Report
  comparison?: Comparison
  scorecard?: boolean
  title?: string
  description?: string
}) {
  if (!comparison)
    return (
      <Notice>No comparable candidates were captured for this report.</Notice>
    )
  const { result, rows } = reportComparisonRows(report, comparison)
  const baseline = rows.get(comparison.baseline)!
  const candidate = rows.get(comparison.candidate)!
  const selected = comparison.candidates.find(
    (item) => item.value === comparison.candidate
  )!
  const baselineLabel = comparison.candidates.find(
    (item) => item.value === comparison.baseline
  )!.label
  const format = (member: string, value: unknown) => {
    const annotation = result.annotation.measures[member]
    return annotation.unit === "ratio" && typeof value === "number"
      ? `${(value * 100).toFixed(1)}%`
      : formatDashboardValue(value, annotation)
  }
  const delta = (metric: Comparison["metrics"][number], value: unknown) => {
    const change = reportMetricChange(
      value,
      baseline[metric.member],
      metric.direction,
      result.annotation.measures[metric.member].unit === "ratio"
    )
    if (!change)
      return <span className="text-foreground-muted">Change unavailable</span>
    const label =
      change.unit === "absolute"
        ? `${change.difference > 0 ? "+" : ""}${format(metric.member, change.difference)}`
        : `${change.amount > 0 ? "+" : ""}${change.amount.toFixed(1)}${change.unit === "pp" ? " pp" : "%"}`
    return (
      <span
        className={cn(
          "font-mono tabular-nums",
          change.tone === "positive"
            ? "text-success"
            : change.tone === "negative"
              ? "text-destructive"
              : "text-foreground-muted"
        )}
      >
        {label}
      </span>
    )
  }
  const statuses = comparison.metrics.map((metric) =>
    reportTargetStatus(
      candidate[metric.member],
      metric.target,
      metric.direction
    )
  )
  const targetCount = comparison.metrics.filter(
    (metric) => metric.target !== undefined
  ).length
  return (
    <section
      aria-label={scorecard ? "Candidate scorecard" : "Candidate comparison"}
      className="space-y-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-medium">
            {title ??
              (scorecard
                ? `Final candidate · ${selected.label}`
                : "Candidates side by side")}
          </h2>
          <p className="mt-2 text-sm text-foreground-muted">
            {scorecard
              ? targetCount
                ? `${statuses.filter((status) => status === "met").length} of ${targetCount} configured targets met`
                : "No targets configured. Changes are measured against the selected baseline."
              : "Rates show percentage-point changes. Other metrics show relative change; zero baselines use absolute differences."}
          </p>
        </div>
        <p className="text-xs text-foreground-muted">
          {scorecard && <>Candidate: {selected.label} · </>}Baseline:{" "}
          {baselineLabel}
        </p>
      </div>
      {description && (
        <p className="max-w-3xl text-sm leading-relaxed text-foreground-muted">
          {description}
        </p>
      )}

      {scorecard ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {comparison.metrics.map((metric, index) => {
            const status = statuses[index]
            const Icon =
              status === "met" ? Check : status === "missed" ? X : Minus
            return (
              <div
                key={metric.member}
                className="min-w-0 rounded-xl bg-muted p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm text-foreground-muted">
                    {metric.label}
                  </h3>
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0",
                      status === "met"
                        ? "text-success"
                        : status === "missed"
                          ? "text-destructive"
                          : "text-foreground-muted"
                    )}
                  />
                </div>
                <p className="mt-4 font-mono text-3xl font-medium tabular-nums">
                  {format(metric.member, candidate[metric.member])}
                </p>
                <p className="mt-2 text-xs">
                  {comparison.candidate === comparison.baseline
                    ? "Baseline"
                    : delta(metric, candidate[metric.member])}
                  <span className="ml-2 text-foreground-muted">
                    vs {baselineLabel}
                  </span>
                </p>
                <div className="mt-5 border-t border-border pt-3 text-xs text-foreground-muted">
                  <p>
                    {status === "missing"
                      ? "No value captured"
                      : status === "unconfigured"
                        ? "No target"
                        : `${status === "met" ? "Target met" : "Target missed"} · ${metric.direction === "higher" ? "≥" : "≤"} ${format(metric.member, metric.target)}`}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div
          className="relative overflow-x-auto rounded-xl bg-muted"
          role="region"
          aria-label="Comparison table"
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th
                  scope="col"
                  className="sticky left-0 z-10 min-w-40 bg-muted p-5 text-left font-medium text-foreground-muted"
                >
                  Metric
                </th>
                {comparison.candidates.map((item) => (
                  <th
                    key={item.value}
                    scope="col"
                    className="min-w-40 p-5 text-right font-medium"
                  >
                    <span className="block">{item.label}</span>
                    <span className="mt-1 block text-xs font-normal text-foreground-muted">
                      {item.value === comparison.baseline
                        ? "Baseline"
                        : `vs ${baselineLabel}`}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.metrics.map((metric) => {
                const best = reportBestValue(
                  comparison.candidates.map(
                    (item) => rows.get(item.value)![metric.member]
                  ),
                  metric.direction
                )
                return (
                  <tr
                    key={metric.member}
                    className="border-b border-border last:border-0"
                  >
                    <th
                      scope="row"
                      className="sticky left-0 bg-muted p-5 text-left font-normal"
                    >
                      <span className="block">{metric.label}</span>
                      <span className="mt-1 block text-xs text-foreground-muted">
                        {metric.direction === "higher"
                          ? "Higher is better"
                          : metric.direction === "lower"
                            ? "Lower is better"
                            : "No preferred direction"}
                      </span>
                    </th>
                    {comparison.candidates.map((item) => {
                      const value = rows.get(item.value)![metric.member]
                      const isBest = best !== null && value === best
                      return (
                        <td
                          key={item.value}
                          className={cn(
                            "p-5 text-right",
                            isBest && "bg-selection"
                          )}
                        >
                          {isBest && (
                            <span className="sr-only">Best value in row: </span>
                          )}
                          <div className="font-mono text-lg tabular-nums">
                            {format(metric.member, value)}
                          </div>
                          <div className="mt-1 text-xs">
                            {item.value === comparison.baseline ? (
                              <span className="text-foreground-muted">—</span>
                            ) : (
                              delta(metric, value)
                            )}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

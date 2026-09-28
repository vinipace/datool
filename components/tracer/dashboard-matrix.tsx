"use client"

import { useMemo, useRef, useState, type CSSProperties } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DimensionLabel } from "@/components/ui/dimension-label"
import { Notice } from "@/components/ui/notice"
import type { SemanticResult } from "@/src/lib/semantic/result"
import {
  dashboardMatrix,
  matrixRowLabels,
  matrixRowSummaries,
  matrixScoreValue,
} from "@/src/lib/tracer/dashboard-matrix"
import { formatDashboardValue } from "./dashboard-utils"
import { isPercentageMetric } from "@/src/lib/tracer/dashboard-metric-comparison"
import { PercentageCell } from "./percentage-cell"
import { DataAnnotationTooltip } from "@/components/ui/data-annotation"
import type { DisplayAnnotation } from "@/src/lib/tracer/dashboard-presentation"
import { cn } from "@/lib/utils"
import {
  matchesReportHighlight,
  type ReportHighlight,
} from "@/src/lib/tracer/report-highlights"

export function DashboardMatrix({
  result,
  summary,
  highlights = [],
}: {
  result: SemanticResult
  summary?: SemanticResult | null
  highlights?: ReportHighlight[]
}) {
  const [rowPage, setRowPage] = useState(0)
  const [columnPage, setColumnPage] = useState(0)
  const [movement, setMovement] = useState({ x: 0, y: 0 })
  const reducedMotion = useReducedMotion()
  const scrollRef = useRef<HTMLDivElement>(null)
  const measure = result.query.measures[0]
  const confusion =
    measure === "evalClassification.caseCount" &&
    // Partial label populations remain a plain count matrix: their raw string
    // labels cannot establish a valid classification outcome for every case.
    result.meta.quality.status === "complete" &&
    result.query.dimensions.length === 2 &&
    result.query.dimensions[0] === "evalClassification.actual" &&
    result.query.dimensions[1] === "evalClassification.predicted" &&
    !!result.query.classification
  const matrix = useMemo(
    () =>
      dashboardMatrix(
        result.data,
        result.query.dimensions,
        measure,
        result.query.order.find(
          ([field]) => field === result.query.dimensions.at(-1)
        )?.[1]
      ),
    [result, measure]
  )
  const annotations = {
    ...result.annotation.dimensions,
    ...result.annotation.measures,
  }
  const labels = useMemo(() => matrixRowLabels(matrix), [matrix])
  const rowSummaries = useMemo(
    () => matrixRowSummaries(summary?.data ?? [], matrix.rowFields, measure),
    [summary, matrix, measure]
  )
  const currentRowPage = Math.min(
    rowPage,
    Math.max(0, Math.ceil(matrix.rows.length / 20) - 1)
  )
  const currentColumnPage = Math.min(
    columnPage,
    Math.max(0, Math.ceil(matrix.columns.length / 12) - 1)
  )
  const rows = matrix.rows.slice(currentRowPage * 20, (currentRowPage + 1) * 20)
  const columnStart = currentColumnPage * 12
  const columns = matrix.columns.slice(columnStart, columnStart + 12)
  const visibleHighlights = highlights.filter((highlight) =>
    rows.some(([key, source]) =>
      columns.some(
        ([column, value]) =>
          matrix.cells.get(JSON.stringify([key, column])) != null &&
          matchesReportHighlight(highlight, {
            ...source,
            [matrix.columnField]: value,
          })
      )
    )
  )
  const partial =
    (result.meta.page.total ?? result.data.length) > result.data.length
  const dimensionValue = (field: string, value: unknown) => (
    <DimensionLabel
      key={field}
      field={field}
      label={annotations[field]?.title ?? field}
      value={formatDashboardValue(value, annotations[field])}
    />
  )
  function page(axis: "row" | "column", direction: number) {
    setMovement(
      axis === "column"
        ? { x: direction * 18, y: 0 }
        : { x: 0, y: direction * 12 }
    )
    if (axis === "column") {
      setColumnPage(Math.max(0, currentColumnPage + direction))
      if (scrollRef.current) scrollRef.current.scrollLeft = 0
    } else {
      setRowPage(Math.max(0, currentRowPage + direction))
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    }
  }
  if (!result.data.length)
    return (
      <p className="py-10 text-center text-sm text-foreground-muted">
        No data in this time range.
      </p>
    )
  return (
    <div className="space-y-3 px-3 pb-3">
      {partial && (
        <Notice variant="warning">
          Showing {result.data.length.toLocaleString()} of{" "}
          {result.meta.page.total?.toLocaleString()} cells. Narrow the filters
          for a complete matrix.
        </Notice>
      )}
      {!confusion && labels.varying.length > 0 && (
        <div
          role="group"
          aria-label="Row label legend"
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {labels.varying.map((field) => (
            <DimensionLabel
              key={field}
              field={field}
              label={annotations[field]?.title ?? field}
            />
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="group"
        aria-label="Matrix values"
        className="overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <motion.table
          key={`${currentRowPage}-${currentColumnPage}`}
          initial={
            reducedMotion || (!movement.x && !movement.y) ? false : movement
          }
          animate={{ x: 0, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
          className="w-full text-left text-xs tabular-nums"
          aria-label={`${annotations[measure]?.title ?? measure} matrix`}
        >
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-24 bg-muted p-2 font-medium text-foreground-muted sm:min-w-32">
                {confusion ? (
                  <span>
                    Actual ↓<br />
                    Predicted →
                  </span>
                ) : labels.varying.length === 1 ? (
                  (annotations[labels.varying[0]]?.title ?? labels.varying[0])
                ) : (
                  "Comparison"
                )}
              </th>
              {summary && (
                <th
                  scope="col"
                  title={`${annotations[measure]?.title ?? measure} across all column groups`}
                  className="min-w-24 p-2 text-right font-medium text-foreground-muted sm:min-w-28"
                >
                  Overall
                </th>
              )}
              {columns.map(([key, value]) => (
                <th
                  key={key}
                  scope="col"
                  title={
                    annotations[matrix.columnField]?.title ?? matrix.columnField
                  }
                  className="min-w-24 p-2 text-right font-medium text-foreground-muted sm:min-w-28"
                >
                  {formatDashboardValue(value, annotations[matrix.columnField])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, source]) => {
              const rowHighlights = visibleHighlights.filter(
                (highlight) =>
                  !(matrix.columnField in highlight.dimensions) &&
                  matchesReportHighlight(highlight, source)
              )
              return (
                <tr
                  key={key}
                  data-highlighted={rowHighlights.length ? true : undefined}
                  className={cn(
                    rowHighlights.length > 0 && "bg-surface-row-hover"
                  )}
                >
                  <DataAnnotationTooltip
                    labels={rowHighlights.map((highlight) => highlight.label)}
                  >
                    <th
                      scope="row"
                      title={
                        rowHighlights.length
                          ? undefined
                          : matrix.rowFields
                              .map(
                                (field) =>
                                  `${annotations[field]?.title ?? field}: ${formatDashboardValue(source[field], annotations[field])}`
                              )
                              .join(" · ")
                      }
                      aria-label={matrix.rowFields
                        .map(
                          (field) =>
                            `${annotations[field]?.title ?? field}: ${formatDashboardValue(source[field], annotations[field])}`
                        )
                        .join(" · ")}
                      className={cn(
                        "sticky left-0 z-10 border-t border-border p-2 font-normal",
                        rowHighlights.length
                          ? "bg-surface-row-hover"
                          : "bg-muted"
                      )}
                    >
                      <div className="flex flex-col items-start gap-1.5">
                        {(confusion ? matrix.rowFields : labels.varying).map(
                          (field) =>
                            confusion ? (
                              <span key={field}>
                                {formatDashboardValue(
                                  source[field],
                                  annotations[field]
                                )}
                              </span>
                            ) : (
                              dimensionValue(field, source[field])
                            )
                        )}
                        {!confusion && !labels.varying.length && (
                          <span>All</span>
                        )}
                      </div>
                    </th>
                  </DataAnnotationTooltip>
                  {[
                    ...(summary ? [["summary", null] as const] : []),
                    ...columns,
                  ].map(([column, columnValue]) => {
                    const isSummary = column === "summary"
                    const classificationCell = confusion && !isSummary
                    const value =
                      (isSummary
                        ? rowSummaries.get(key)
                        : matrix.cells.get(JSON.stringify([key, column]))) ??
                      null
                    const score = matrixScoreValue(measure, value)
                    const positive = String(
                      result.query.classification?.positiveClass
                    )
                    const actualPositive =
                      String(source["evalClassification.actual"]) === positive
                    const predictedPositive = String(columnValue) === positive
                    const correct = actualPositive === predictedPositive
                    const missingLabel =
                      source["evalClassification.actual"] == null ||
                      columnValue == null
                    const outcome = missingLabel
                      ? "Missing label"
                      : predictedPositive
                        ? correct
                          ? "True positive"
                          : "False positive"
                        : correct
                          ? "True negative"
                          : "False negative"
                    const cellHighlights =
                      value === null || isSummary
                        ? []
                        : visibleHighlights.filter((highlight) =>
                            matchesReportHighlight(highlight, {
                              ...source,
                              [matrix.columnField]: columnValue,
                            })
                          )
                    // Fixed score scale; colors come from the shared theme tokens.
                    const heat =
                      classificationCell
                        ? value === null || missingLabel
                          ? undefined
                          : correct
                            ? "var(--score-heat-high)"
                            : "var(--score-heat-low)"
                        : score === null
                          ? undefined
                          : score < 0.5
                            ? `color-mix(in oklch, var(--score-heat-low), var(--score-heat-mid) ${score * 200}%)`
                            : `color-mix(in oklch, var(--score-heat-mid), var(--score-heat-high) ${(score - 0.5) * 200}%)`
                    return (
                      <DataAnnotationTooltip
                        key={column}
                        labels={[
                          ...(classificationCell && value !== null
                            ? [outcome]
                            : []),
                          ...cellHighlights.map((highlight) => highlight.label),
                        ]}
                      >
                        <td
                          className={cn(
                            "relative p-2 text-right font-mono",
                            !heat &&
                              !confusion &&
                              cellHighlights.length > 0 &&
                              "bg-selection"
                          )}
                          aria-label={
                            classificationCell && value !== null
                              ? `${formatDashboardValue(value, annotations[measure])} ${outcome}`
                              : undefined
                          }
                          data-highlighted={
                            cellHighlights.length ? true : undefined
                          }
                          data-score={score ?? undefined}
                          style={
                            heat
                              ? ({
                                  "--color-score-fill": heat,
                                } as CSSProperties)
                              : undefined
                          }
                        >
                          {heat && (
                            <div
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-1 rounded-md"
                              style={{
                                backgroundColor: `color-mix(in srgb, ${heat} ${cellHighlights.length ? 52 : 32}%, var(--muted))`,
                              }}
                            />
                          )}
                          <div
                            className={cn(
                              "relative",
                              classificationCell && cellHighlights.length > 0 &&
                                "underline decoration-dashed underline-offset-4"
                            )}
                          >
                            {typeof value === "number" &&
                              isPercentageMetric(annotations[measure]) ? (
                              <PercentageCell
                                value={value}
                                fractionDigits={
                                  (annotations[measure] as DisplayAnnotation)
                                    ?.display?.decimals ?? 1
                                }
                              />
                            ) : (
                              formatDashboardValue(value, annotations[measure])
                            )}
                          </div>
                        </td>
                      </DataAnnotationTooltip>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </motion.table>
      </div>
      {(matrix.rows.length > 20 || matrix.columns.length > 12) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          {matrix.rows.length > 20 && (
            <div
              role="group"
              aria-label="Row pages"
              className="flex items-center gap-1"
            >
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Previous rows"
                title="Previous rows"
                disabled={currentRowPage === 0}
                onClick={() => page("row", -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Next rows"
                title="Next rows"
                disabled={(currentRowPage + 1) * 20 >= matrix.rows.length}
                onClick={() => page("row", 1)}
              >
                <ArrowDown />
              </Button>
            </div>
          )}
          {matrix.columns.length > 12 && (
            <div
              role="group"
              aria-label="Column pages"
              className="flex items-center gap-1"
            >
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Previous columns"
                title="Previous columns"
                disabled={currentColumnPage === 0}
                onClick={() => page("column", -1)}
              >
                <ArrowLeft />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Next columns"
                title="Next columns"
                disabled={columnStart + 12 >= matrix.columns.length}
                onClick={() => page("column", 1)}
              >
                <ArrowRight />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

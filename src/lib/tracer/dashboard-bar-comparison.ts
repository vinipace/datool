import type { SemanticDataRow, SemanticResult } from "@/src/lib/semantic/result"
import type { DashboardWidget } from "./dashboards"
import type { ReportReference } from "./report-highlights"
import {
  defaultMetricTrendDirection,
  type MetricTrendDirection,
} from "./dashboard-metric-comparison"

export type DashboardBarBaseline = {
  value: number
  row?: SemanticDataRow
  label?: string
  direction: MetricTrendDirection
}

/** Resolve against the full frozen result, before display pagination. */
export function dashboardBarBaseline(
  widget: DashboardWidget,
  result: Pick<SemanticResult, "query" | "data">,
  references: ReportReference[] = []
): DashboardBarBaseline | undefined {
  if (widget.type !== "bar") return
  const measure = result.query.measures[0]
  const direction =
    widget.trendDirection ?? defaultMetricTrendDirection(measure)
  const matching = references.filter(
    (reference) =>
      reference.widgetId === widget.id && reference.measure === measure
  )
  if (matching.length > 1) return // Do not silently choose between reference values.
  if (matching.length === 1) {
    const reference = matching[0]
    const rows = result.data.filter((row) => row[measure] === reference.value)
    return {
      value: reference.value,
      direction,
      label: reference.label,
      ...(rows.length === 1 ? { row: rows[0] } : {}),
    }
  }
  // Without an authored reference, a directed, category-ordered report uses its
  // first category. Display that category explicitly; never use a metric rank.
  const [order] = result.query.order
  if (
    direction === "neutral" ||
    result.query.offset !== 0 ||
    !order ||
    order[1] !== "asc" ||
    !result.query.dimensions.includes(order[0])
  )
    return
  const row = result.data[0]
  const value = row?.[measure]
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return { value, row, direction }
}

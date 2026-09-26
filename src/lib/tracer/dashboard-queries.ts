import {
  parseFilterQuery,
  filterDate,
} from "@/components/ui/datool/search-bar/filter-query"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import type { DashboardWidget } from "./dashboards"
import { evalQualityExpressionFilters } from "./eval-quality-filters"

export type DashboardScope = {
  dateFilter?: string
  rangeEnd?: number
  filter: string
  from: string
  to: string
  timezone: string
}
export function scopedWidget(
  widget: DashboardWidget,
  scope: DashboardScope
): DashboardWidget {
  const model = widget.query.measures[0].split(".")[0]
  if (
    scope.filter &&
    !["logs", "spans", "traces", "evalQuality", "evalResults"].includes(model)
  )
    throw new Error(
      `Shared trace filters are not supported by ${model} widgets.`
    )
  return {
    ...widget,
    query: {
      ...widget.query,
      timezone: scope.timezone,
      timeDimensions: widget.query.timeDimensions.map((time) => ({
        ...time,
        dateRange: [scope.from, scope.to],
      })),
      filters: [
        ...widget.query.filters,
        ...(["evalQuality", "evalResults"].includes(model)
          ? evalQualityExpressionFilters(scope.filter, model)
          : traceExpressionFilters(scope.filter, model, Date.parse(scope.to))),
      ],
    },
  }
}

/** Date clauses in the shared bar select the metric window, not parent trace age. */
export function dashboardFilterScope(
  expression: string,
  now: number,
  timezone: string
): DashboardScope {
  const clauses = parseFilterQuery(expression)
  let from: number | undefined
  let to: number | undefined
  const remaining: string[] = []
  for (const clause of clauses) {
    if (
      "text" in clause ||
      clause.path.length !== 1 ||
      clause.path[0] !== "startedAt"
    ) {
      remaining.push(expression.slice(clause.start, clause.end))
      continue
    }
    const instant =
      typeof clause.value === "string" ? filterDate(clause.value, now) : NaN
    if (!Number.isFinite(instant))
      throw new Error("Started at requires a date or relative time.")
    switch (clause.operator) {
      case ">=":
        from = Math.max(from ?? -Infinity, instant)
        break
      case ">":
        from = Math.max(from ?? -Infinity, instant + 1)
        break
      case "<":
        to = Math.min(to ?? Infinity, instant)
        break
      case "<=":
        to = Math.min(to ?? Infinity, instant + 1)
        break
      case "=":
      case ":":
        from = Math.max(from ?? -Infinity, instant)
        to = Math.min(to ?? Infinity, instant + 1)
        break
      default:
        throw new Error("Dashboard date ranges support =, >=, >, <= and <.")
    }
  }
  to ??= now
  from ??= to - 90 * 86400000
  if (from >= to)
    throw new Error("The date filter must select a non-empty range.")
  if (to - from > 90 * 86400000)
    throw new Error("Dashboard date ranges cannot exceed 90 days.")
  return {
    filter: remaining.join(" "),
    dateFilter: remaining.length ? undefined : expression,
    rangeEnd: now,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timezone,
  }
}

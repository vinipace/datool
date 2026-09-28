import {
  isDashboardDataWidget,
  type DashboardWidget,
  type DashboardContentWidget,
} from "./dashboards"
import { previousPeriodQuery } from "./dashboard-metric-comparison"
import { dashboardCohorts } from "./dashboard-filters"

export function dashboardQueryPlan(
  items: DashboardContentWidget[],
  offsets: Record<string, number>
) {
  const queries: DashboardWidget["query"][] = []
  const batches: DashboardWidget["query"][][] = [[]]
  const positions = items.filter(isDashboardDataWidget).map((item) => {
    const cohorts = dashboardCohorts(item)
    const timeChart = item.type === "line" || item.type === "stacked"
    // A whole-window aggregate cannot summarize only the groups that passed
    // a measure threshold (averages and percentiles are not additive).
    const matrixSummary =
      item.type === "matrix" && item.presentation?.showSummary === true
    const includeSummary =
      (timeChart || matrixSummary) && !item.query.having?.length
    const includePrevious = item.type === "metric"
    // Never split a widget's curves and totals across database snapshots.
    if (
      batches.at(-1)!.length +
        cohorts.length * (includePrevious ? 3 : includeSummary ? 2 : 1) >
      40
    )
      batches.push([])
    const batch = batches.at(-1)!
    return {
      id: item.id,
      cohorts: cohorts.map((cohort, index) => {
        const offsetKey = `${item.id}:${index}`
        const query = {
          ...cohort.query,
          offset:
            item.type === "matrix"
              ? 0
              : (offsets[offsetKey] ?? item.query.offset),
          ...(item.type === "matrix" ? { limit: 5000 } : {}),
          total: true,
        }
        const result = queries.push(query) - 1
        batch.push(query)
        let previous: number | null = null
        let history: number | null = null
        if (includePrevious) {
          const previousQuery = previousPeriodQuery(query)
          previous = queries.push(previousQuery) - 1
          batch.push(previousQuery)
          const historyQuery: DashboardWidget["query"] = {
            ...query,
            // The tile's threshold applies to its whole-period aggregate,
            // not to individual days. Keep every day in the selected cohort.
            having: [],
            timeDimensions: query.timeDimensions.map((time) => ({
              ...time,
              granularity: "day",
            })),
            order: [[query.timeDimensions[0].dimension, "asc"]],
            // A supported 90-day window can touch 91 calendar days. A scalar
            // query's limit (often 1) must not truncate this time series.
            limit: 100,
            offset: 0,
          }
          history = queries.push(historyQuery) - 1
          batch.push(historyQuery)
        }
        let summary: number | null = null
        if (includeSummary) {
          const summaryQuery = {
            ...query,
            dimensions: matrixSummary
              ? query.dimensions.slice(0, -1)
              : query.dimensions,
            timeDimensions: query.timeDimensions.map(
              ({ dimension, dateRange }) => ({ dimension, dateRange })
            ),
            order: [],
            offset: 0,
            ...(query.dimensions.length ? { limit: 5000 } : {}),
          }
          summary = queries.push(summaryQuery) - 1
          batch.push(summaryQuery)
        }
        return {
          label: cohort.label,
          result,
          summary,
          previous,
          history,
          offsetKey,
        }
      }),
    }
  })
  return { batches: batches.filter((batch) => batch.length), positions }
}

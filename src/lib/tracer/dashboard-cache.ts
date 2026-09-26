import { parseFilterQuery } from "@/components/ui/datool/search-bar/filter-query"
import { dashboardFilterScope } from "./dashboard-queries"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"

export type DashboardCacheHint = {
  dateFilter: string
  rangeEnd: number
  force?: boolean
}

/** Only replace time windows proven to come from this date selection. */
export function dashboardCachePlan(
  queries: NormalizedSemanticQuery[],
  hint: DashboardCacheHint,
  now = Date.now()
) {
  if (!queries.length || !Number.isFinite(hint.rangeEnd)) return null
  const timezone = queries[0].timezone
  const scope = dashboardFilterScope(hint.dateFilter, hint.rangeEnd, timezone)
  if (scope.filter || queries.some((query) => query.timezone !== timezone))
    return null
  const clauses = parseFilterQuery(hint.dateFilter)
    .map((clause) => {
      if ("text" in clause) throw new Error("Date-only filters required.")
      return {
        operator: clause.operator === ":" ? "=" : clause.operator,
        value: clause.value,
      }
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const from = Date.parse(scope.from),
    to = Date.parse(scope.to)
  const previousFrom = from - (to - from)
  const normalized = queries.map((query) => ({
    ...query,
    timeDimensions: query.timeDimensions.map((time) => {
      const start = Date.parse(time.dateRange[0]),
        end = Date.parse(time.dateRange[1])
      const period =
        start === from && end === to
          ? "current"
          : start === previousFrom && end === from
            ? "previous"
            : null
      if (!period)
        throw new Error(
          "Query dates do not match the dashboard date selection."
        )
      return { ...time, dateRange: period }
    }),
  }))
  if (queries.some((query) => !query.timeDimensions.length)) return null
  const current = dashboardFilterScope(hint.dateFilter, now, timezone)
  const currentFrom = Date.parse(current.from),
    currentTo = Date.parse(current.to)
  const refreshed = queries.map((query, index) => ({
    ...query,
    timeDimensions: query.timeDimensions.map((time, timeIndex) => ({
      ...time,
      dateRange:
        normalized[index].timeDimensions[timeIndex].dateRange === "current"
          ? ([current.from, current.to] as [string, string])
          : ([
              new Date(currentFrom - (currentTo - currentFrom)).toISOString(),
              current.from,
            ] as [string, string]),
    })),
  }))
  return {
    key: {
      sourceContract: "five-sources-v1",
      dateFilter: clauses,
      timezone,
      queries: normalized,
    },
    queries: refreshed,
  }
}

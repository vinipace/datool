import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import type { SemanticDataRow, SemanticResult } from "@/src/lib/semantic/result"
import { groupedTimeChart } from "@/src/lib/tracer/dashboard-time-series"

export type DashboardCohortResult = {
  label?: string
  result: SemanticResult
  summary: SemanticResult | null
  previous?: SemanticResult | null
  history?: SemanticResult | null
  offsetKey: string
}

/** A view-only pivot: each cohort keeps its own aggregate, including percentiles. */
export function comparisonTimeChart(
  widget: DashboardWidget,
  cohorts: DashboardCohortResult[]
) {
  const first = cohorts[0]
  const time = first.result.query.timeDimensions[0].dimension
  const rows = new Map<string, SemanticDataRow>()
  const measures: string[] = [],
    series: string[] = []
  const annotations: SemanticResult["annotation"]["measures"] = {}
  const totals: SemanticDataRow = {}
  const stackGroups: Record<string, string> = {}
  cohorts.forEach((source, index) => {
    const cohort = {
      ...source,
      ...groupedTimeChart(widget, source.result, source.summary),
    }
    cohort.widget.query.measures.forEach((member, measureIndex) => {
      const key = `comparison.c${index}m${measureIndex}`
      measures.push(key)
      if (
        (cohort.widget.series ?? cohort.widget.query.measures).includes(member)
      )
        series.push(key)
      const original = cohort.result.annotation.measures[member]
      annotations[key] = {
        ...original,
        name: key,
        title: `${cohort.label} · ${original?.title ?? member}`,
      }
      stackGroups[key] = `cohort${index}`
      totals[key] = cohort.summary?.data[0]?.[member] ?? null
      cohort.result.data.forEach((row) => {
        const bucket = String(row[time])
        const output = rows.get(bucket) ?? { [time]: row[time] }
        output[key] = row[member]
        rows.set(bucket, output)
      })
    })
  })
  const query = { ...first.result.query, dimensions: [], measures }
  const annotation = { ...first.result.annotation, measures: annotations }
  const data = [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row)
  const complete = cohorts.every(
    ({ result }) =>
      result.query.offset === 0 && result.meta.page.total === result.data.length
  )
  return {
    widget: { ...widget, query, series },
    stackGroups,
    result: {
      ...first.result,
      query,
      annotation,
      data,
      meta: {
        ...first.result.meta,
        page: {
          ...first.result.meta.page,
          total: complete ? data.length : undefined,
        },
      },
    },
    summary: first.summary
      ? {
          ...first.summary,
          query: { ...first.summary.query, measures },
          annotation,
          data: [totals],
        }
      : null,
  }
}

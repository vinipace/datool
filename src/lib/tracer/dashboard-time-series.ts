import type { SemanticDataRow, SemanticResult } from "@/src/lib/semantic/result"
import type { DashboardWidget } from "./dashboards"

/** Pivot already-aggregated time/group rows without summing averages or filling missing costs. */
export function groupedTimeChart(
  widget: DashboardWidget,
  result: SemanticResult,
  summary: SemanticResult | null
) {
  const dimension = result.query.dimensions[0]
  if (!dimension || !result.data.length) return { widget, result, summary }
  const time = result.query.timeDimensions[0].dimension
  const identity = (row: SemanticDataRow) =>
    JSON.stringify(row[dimension] ?? null)
  const categories = new Map(
    result.data.map((row) => [identity(row), row[dimension]])
  )
  const measures: string[] = []
  const series: string[] = []
  const annotations: SemanticResult["annotation"]["measures"] = {}
  const totals: SemanticDataRow = {}
  const rows = new Map<string, SemanticDataRow>()
  const summaries = new Map(
    summary?.data.map((row) => [identity(row), row]) ?? []
  )
  // Stable category order keeps series colors independent of SQL row ordering.
  const groups = [...categories].sort(([a], [b]) => a.localeCompare(b))
  groups.forEach(([category, label], groupIndex) => {
    widget.query.measures.forEach((member, measureIndex) => {
      const key = `series.g${groupIndex}m${measureIndex}`
      const original = result.annotation.measures[member]
      measures.push(key)
      if ((widget.series ?? widget.query.measures).includes(member))
        series.push(key)
      annotations[key] = {
        ...original,
        name: key,
        title: `${label ?? "Not recorded"}${widget.query.measures.length > 1 ? ` · ${original.title}` : ""}`,
      }
      totals[key] = summaries.get(category)?.[member] ?? null
    })
  })
  const groupIndexes = new Map(groups.map(([key], index) => [key, index]))
  for (const row of result.data) {
    const bucket = String(row[time])
    const output = rows.get(bucket) ?? {
      [time]: row[time],
      ...Object.fromEntries(measures.map((key) => [key, null])),
    }
    const index = groupIndexes.get(identity(row))!
    widget.query.measures.forEach((member, measureIndex) => {
      output[`series.g${index}m${measureIndex}`] = row[member]
    })
    rows.set(bucket, output)
  }
  const data = [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row)
  const query = { ...result.query, dimensions: [], measures }
  const annotation = {
    ...result.annotation,
    dimensions: {},
    measures: annotations,
  }
  const complete =
    result.query.offset === 0 && result.meta.page.total === result.data.length
  return {
    widget: { ...widget, query, series },
    result: {
      ...result,
      query,
      annotation,
      data,
      meta: {
        ...result.meta,
        page: {
          ...result.meta.page,
          total: complete ? data.length : undefined,
        },
      },
    },
    summary: summary
      ? {
          ...summary,
          query: { ...summary.query, dimensions: [], measures },
          annotation,
          data: [totals],
        }
      : null,
  }
}

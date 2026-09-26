import type { SemanticResult } from "@/src/lib/semantic/result"
import { formatSemanticDay } from "@/src/lib/semantic/runtime/time"

/** Complete the calendar axis for models that omit days without matching facts. */
export function dashboardMetricHistory(
  result: SemanticResult,
  measure = result.query.measures[0]
) {
  const time = result.query.timeDimensions[0]
  const aggregation = result.annotation.measures[measure]?.aggregation
  const missing =
    aggregation === "count" || aggregation === "countDistinct" ? 0 : null
  const values = new Map(
    result.data.map((row) => [String(row[time.dimension]), row[measure]])
  )
  const first = formatSemanticDay(time.dateRange[0], result.query.timezone)
  const last = formatSemanticDay(
    Date.parse(time.dateRange[1]) - 1,
    result.query.timezone
  )
  // Iterate calendar dates, not 24-hour increments in the reporting timezone:
  // a DST day can contain 23 or 25 hours. The range end is exclusive.
  const cursor = new Date(`${first}T00:00:00Z`)
  const data: { date: string; value: number | null }[] = []
  for (
    let date = first;
    date <= last;
    date = cursor.toISOString().slice(0, 10)
  ) {
    const value = values.has(date) ? values.get(date) : missing
    data.push({
      date,
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return data
}

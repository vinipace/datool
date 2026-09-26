import type { SemanticDataRow } from "../semantic"

export type PerformanceModel = "agents" | "workflows"
export const performanceMeasures = [
  "count",
  "versionCount",
  "completedCount",
  "erroredCount",
  "runningCount",
  "cancelledCount",
  "errorRate",
  "meanDurationMs",
  "p95DurationMs",
  "durationSampleCount",
  "reportedCostUsd",
  "completeCostCount",
] as const

export type PerformanceTableRow = {
  id: string
  groupType: "agent" | "workflow"
  name: string
  version: string | null
  metrics: Record<(typeof performanceMeasures)[number], number | null>
}

/** Keep aggregate metrics available to the same custom-field editor as other tables. */
export function performanceTableRow(
  row: SemanticDataRow,
  model: PerformanceModel
): PerformanceTableRow {
  const name = String(row[`${model}.name`])
  const version =
    row[`${model}.version`] == null ? null : String(row[`${model}.version`])
  return {
    id: JSON.stringify([model, name, version]),
    groupType: model === "agents" ? "agent" : "workflow",
    name,
    version,
    metrics: Object.fromEntries(
      performanceMeasures.map((measure) => {
        const value = row[`${model}.${measure}`]
        return [measure, typeof value === "number" ? value : null]
      })
    ) as PerformanceTableRow["metrics"],
  }
}

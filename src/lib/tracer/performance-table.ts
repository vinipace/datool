import type { SemanticDataRow } from "../semantic"
import { agentAppearanceSchema } from "../build/contracts"

const agentAvatarSchema = agentAppearanceSchema.pick({
  avatarUrl: true,
  avatarStyle: true,
  avatarColor: true,
})

export type PerformanceModel = "agents" | "workflows"
export const agentDirectoryDimensions = [
  "agents.name",
  "agents.identity",
  "agents.managedId",
  "agents.managedStatus",
  "agents.avatarUrl",
  "agents.avatarStyle",
  "agents.avatarColor",
]

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
  managedId?: string
  managedStatus?: string
  avatar?: ReturnType<typeof agentAvatarSchema.parse>
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
    id:
      typeof row[`${model}.identity`] === "string"
        ? String(row[`${model}.identity`])
        : JSON.stringify([model, name, version]),
    ...(typeof row[`${model}.managedId`] === "string"
      ? {
          managedId: String(row[`${model}.managedId`]),
          managedStatus: String(row[`${model}.managedStatus`]),
          avatar: agentAvatarSchema.parse({
            avatarUrl: row[`${model}.avatarUrl`] ?? undefined,
            avatarStyle: row[`${model}.avatarStyle`] ?? undefined,
            avatarColor: row[`${model}.avatarColor`] ?? undefined,
          }),
        }
      : {}),
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

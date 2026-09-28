import type { JsonObject } from "./contracts"
import type { ViewObjectType } from "./view-resources"
export type FieldRow = { id: string; kind: ViewObjectType; object: JsonObject; context: JsonObject }

/** Collection adapters retain the object separately from wrapper/result context. */
export function fieldRow(kind: ViewObjectType, row: unknown): FieldRow {
  const record = row as Record<string, unknown>
  const source = (record.object ?? record.trace ?? record.run ?? record.session ?? record.item ?? record.app ?? record) as Record<string, unknown>
  const object = kind === "app"
    ? Object.fromEntries(["id", "name", "description", "connectionType", "status", "createdAt", "updatedAt"].filter(key => source[key] !== undefined).map(key => [key, source[key]]))
    : source
  return { id: String(record.id ?? source.id ?? "sample"), kind, object: JSON.parse(JSON.stringify(object)), context: JSON.parse(JSON.stringify(record.context ?? (record.trace ? { trace: record.trace, results: record.results, datasetItem: record.datasetItem, expectedOutput: record.expectedOutput, datasetItemId: record.datasetItemId } : {}))) }
}
export function fieldRowInput(row: FieldRow) {
  const metrics = row.object.attributes && typeof row.object.attributes === "object" && !Array.isArray(row.object.attributes)
    ? row.object.attributes.metrics : undefined
  const source = metrics && typeof metrics === "object" && !Array.isArray(metrics) ? metrics : {}
  const cost = source.costUsd ?? (row.object.attributes && typeof row.object.attributes === "object" && !Array.isArray(row.object.attributes) ? row.object.attributes["cost.usd"] : undefined)
  return {
    ...row.object, ...row.context, id: row.id, kind: row.kind, object: row.object, context: row.context,
    ...(row.kind === "trace" || row.kind === "eval-result" || row.kind === "review-item" ? { metrics: { ...source, cost: typeof cost === "number" ? cost : undefined, durationMs: row.object.durationMs } } : {}),
  }
}

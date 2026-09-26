import { columnRow, type ComputedResource, type ComputedRow, type EvalTableRow } from "./computed-columns"
import { performanceMeasures } from "./performance-table"

const metricTypes = {
  cost: "number",
  costUsd: "number",
  knownCostUsd: "number",
  durationMs: "number | null",
  inputTokens: "number",
  outputTokens: "number",
  totalTokens: "number",
  cachedInputTokens: "number",
  cacheWriteTokens: "number",
  reasoningTokens: "number",
  llmCalls: "number",
  models: "string[]",
  usageStatus: "string",
  costStatus: "string",
}

/** Merge object keys across every loaded row and array element. Values only
 * inform types; their contents are never embedded in executable declarations. */
export function inferredType(values: unknown[], depth = 0): string {
  if (depth > 12) return "unknown"
  const types = new Set<string>()
  const objects: Record<string, unknown>[] = []
  const arrays: unknown[][] = []
  for (const value of values) {
    if (value === null) types.add("null")
    else if (Array.isArray(value)) arrays.push(value)
    else if (typeof value === "object")
      objects.push(value as Record<string, unknown>)
    else if (
      ["string", "number", "boolean", "undefined"].includes(typeof value)
    )
      types.add(typeof value)
  }
  if (arrays.length)
    types.add(`Array<${inferredType(arrays.flat(), depth + 1)}>`)
  if (objects.length) {
    const keys = [...new Set(objects.flatMap(Object.keys))].sort()
    types.add(
      `{ ${keys
        .map(
          (key) =>
            `${JSON.stringify(key)}${objects.some((object) => !(key in object)) ? "?" : ""}: ${inferredType(
              objects.map((object) => object[key]),
              depth + 1
            )}`
        )
        .join("; ")} }`
    )
  }
  return [...types].join(" | ") || "unknown"
}

const fallbackRow = `{
  id: string; name: string; operation: string; status: string;
  input: unknown; output: unknown; expectedOutput: unknown;
  durationMs: number | null; startedAt: string; endedAt: string | null;
  sessionId: string | null; datasetItemId: string | null;
  attributes: Record<string, unknown>; trace: Record<string, unknown>;
  results: Array<{ id: string; evaluatorId: string; evaluatorName: string;
    evaluatorVersion: number; score: number | null; passed: boolean | null;
    reasoning: string | null; error: string | null; metadata: Record<string, unknown>;
    completedAt: string | null; runId: string; traceId: string;
    datasetItemId: string | null; status: string }>;
  metrics: Record<string, unknown>;
}`

export function rowDeclarations(rows: ComputedRow[], resource: ComputedResource = "eval") {
  if (resource === "performance") {
    return `/** Current group and its aggregate metrics for the selected time range. */
declare const row: {
  id: string; groupType: "agent" | "workflow"; name: string; version: string | null;
  metrics: { ${performanceMeasures.map((measure) => `${measure}: number | null`).join("; ")} };
};`
  }
  if (resource === "dataset") {
    const fallback = `{ id: string; datasetId: string; input: unknown; expectedOutput: unknown; metadata: Record<string, unknown>; sourceTraceId: string | null; createdAt: string; updatedAt: string }`
    return `/** Current dataset item. Custom fields are read-only. */
declare const row: ${rows.length ? inferredType(rows.map(columnRow)) : fallback};`
  }
  return evalRowDeclarations(rows.filter((row): row is EvalTableRow => "trace" in row))
}

function evalRowDeclarations(rows: EvalTableRow[]) {
  return `type BaseEvalRow = ${fallbackRow};
type ObservedEvalRow = ${rows.length ? inferredType(rows.map(columnRow)) : "BaseEvalRow"};
type EvalMetrics = {
${Object.entries(metricTypes)
  .map(
    ([key, type]) =>
      `${key === "cost" ? "/** Trace cost in USD. Undefined when unavailable. */" : ""}\n${key}?: ${type};`
  )
  .join("\n")}
};
/** Current eval target. Field shapes are inferred from all loaded rows. */
declare const row: Omit<ObservedEvalRow, "metrics" | "results"> & {
  results: ${rows.some((row) => row.results.length) ? "ObservedEvalRow" : "BaseEvalRow"}["results"];
  metrics: Omit<ObservedEvalRow["metrics"], keyof EvalMetrics> & EvalMetrics;
};`
}

/** Same offsets and newlines as the visible template, with only expressions
 * exposed to the JavaScript language service. Incomplete expressions still work. */
export function templateJavaScript(text: string) {
  let output = "",
    index = 0
  while (index < text.length) {
    const open = text.indexOf("{{", index)
    if (open < 0) {
      output += text.slice(index).replace(/[^\r\n]/g, " ")
      break
    }
    output += text.slice(index, open).replace(/[^\r\n]/g, " ") + "( "
    const close = text.indexOf("}}", open + 2)
    if (close < 0) {
      output += text.slice(open + 2)
      break
    }
    output += text.slice(open + 2, close) + ");"
    index = close + 2
  }
  return output
}

export function inTemplateExpression(text: string, offset: number) {
  const before = text.slice(0, offset)
  return before.lastIndexOf("{{") > before.lastIndexOf("}}")
}

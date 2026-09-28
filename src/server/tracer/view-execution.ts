import { transform } from "esbuild"
import { columnExpression } from "@/src/lib/tracer/computed-columns"
import { fieldSupportsObject, type CustomField } from "@/src/lib/tracer/custom-fields"
import { viewCompatibility, type ReactView } from "@/src/lib/tracer/react-views"
import type { ViewObjectType } from "@/src/lib/tracer/view-resources"
import type { JsonObject, TraceForEvaluation } from "@/src/lib/tracer/contracts"
import { runEvaluator } from "../sandbox/evaluator"
import { validation } from "./errors"
import { fieldRow, fieldRowInput } from "@/src/lib/tracer/field-row"

export async function evaluateCustomField(field: CustomField, kind: ViewObjectType, rows: JsonObject[]) {
  if (!fieldSupportsObject(field, kind)) throw validation(`This field supports ${field.objectTypes.join(", ")}, not ${kind}.`)
  const expression = columnExpression(field)
  const code = `async function evaluate({trace}) {
    const row = trace.input;
    const value = await (${expression});
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Expression returned a non-finite number");
    if (value !== undefined && JSON.stringify(value) === undefined) throw new Error("Field values must be JSON serializable");
    const type = Array.isArray(value) ? "array" : typeof value;
    if (value != null && ${JSON.stringify(field.resultType)} !== "any" && type !== ${JSON.stringify(field.resultType)}) throw new Error("Field result does not match its declared type");
    return {score:1,metadata:{value:value ?? null,missing:value === undefined}};
  }`
  const results = []
  for (const row of rows) {
    const trace: TraceForEvaluation = { id: "field-preview", name: "Custom Field preview", operation: "custom-field", input: fieldRowInput(fieldRow(kind, row)), output: null, attributes: {}, spans: [], sessionId: null, status: "completed", startedAt: new Date().toISOString(), endedAt: null }
    const result = await runEvaluator({ code, trace, timeoutMs: 500 })
    results.push(result.error ? { value: null, error: result.error } : { value: result.metadata?.value ?? null, missing: result.metadata?.missing === true })
  }
  return { id: field.id, revision: field.revision, evaluated: true, results, limits: { rows: 20, timeoutMs: 500, resultBytes: 16384 }, query: { filter: false, sort: false } }
}

export async function previewObjectView(view: ReactView, kind: "trace" | "dataset-item", object: unknown) {
  if (!(view.objectTypes ?? ["trace", "dataset-item"]).includes(kind)) throw validation(`This Object View does not support ${kind}.`)
  try {
    await transform(view.code, { loader: "tsx", jsx: "automatic", format: "esm", target: "es2022" })
    return { id: view.id, revision: view.revision, compiled: true, rendered: false, compatibility: viewCompatibility(view.requirements, object), diagnostics: [], message: "Syntax compilation only. Open the Object View browser preview to verify imports, styles and rendering." }
  } catch (error) {
    return { id: view.id, revision: view.revision, compiled: false, rendered: false, compatibility: viewCompatibility(view.requirements, object), diagnostics: [error instanceof Error ? error.message.slice(0,4000) : "Compilation failed"] }
  }
}

import { z } from "zod"
import type { CreateEvalRunInput, JsonObject, JsonValue } from "./contracts"

export const inputOverridesSchema = z
  .record(z.string(), z.json())
  .describe(
    "Connected dataset runs only. Shallow merge over each object case input; override keys win, nested objects and arrays replace whole values, and null is literal. Never merges expectedOutput or metadata."
  )

export function validateInputOverrides(input: CreateEvalRunInput) {
  if (input.inputOverrides === undefined) return
  if (
    (input.mode !== "connected" && !input.parentRunId) ||
    (!input.datasetId && !input.parentRunId) ||
    input.sourceRunId ||
    input.input !== undefined ||
    input.traceIds?.length
  )
    throw new Error(
      "inputOverrides requires a connected dataset run without sourceRunId, traceIds or single app input."
    )
  return inputOverridesSchema.parse(input.inputOverrides) as JsonObject
}

export function effectiveEvalInput(
  input: JsonValue,
  overrides?: JsonObject
): JsonValue {
  if (overrides === undefined) return structuredClone(input)
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "inputOverrides requires every selected dataset input to be a JSON object."
    )
  return structuredClone({ ...input, ...overrides })
}

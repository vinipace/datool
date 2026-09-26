import Ajv, { type ValidateFunction } from "ajv"
import addFormats from "ajv-formats"
import type {
  DatasetField,
  DatasetFieldSchemas,
  JsonObject,
  JsonValue,
} from "./contracts"

export const datasetFields = ["input", "expectedOutput", "metadata"] as const
export const datasetFieldLabels: Record<DatasetField, string> = {
  input: "Input",
  expectedOutput: "Expected",
  metadata: "Metadata",
}
const validators = new Map<string, ValidateFunction>()

/** Draft-07 schemas are annotations until enforcement is enabled; never coerce row data. */
function validator(schema: JsonObject) {
  const key = JSON.stringify(schema)
  if (key.length > 65_536)
    throw new Error("A field schema must be smaller than 64 KiB.")
  const cached = validators.get(key)
  if (cached) return cached
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    strictSchema: true,
    addUsedSchema: false,
  })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  if (schema.$async) throw new Error("Asynchronous schemas are not supported.")
  if (validators.size >= 100) validators.delete(validators.keys().next().value!)
  validators.set(key, validate)
  return validate
}

export function assertDatasetSchemas(schemas: DatasetFieldSchemas) {
  for (const field of datasetFields) {
    const config = schemas[field]
    if (!config) continue
    if (config.enforced && !config.schema)
      throw new Error(
        `${datasetFieldLabels[field]} needs a schema before enforcement can be enabled.`
      )
    if (config.schema) {
      try {
        validator(config.schema)
      } catch (error) {
        throw new Error(
          `${datasetFieldLabels[field]} schema: ${error instanceof Error ? error.message : "Invalid JSON Schema."}`
        )
      }
    }
  }
}

export function datasetFieldErrors(
  schema: JsonObject | null | undefined,
  value: JsonValue
): string[] {
  if (!schema) return []
  try {
    const validate = validator(schema)
    if (validate(value)) return []
    return (validate.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
  } catch (error) {
    return [error instanceof Error ? error.message : "Invalid JSON Schema."]
  }
}

export function assertDatasetItemSchemas(
  schemas: DatasetFieldSchemas,
  item: { input: JsonValue; expectedOutput?: JsonValue; metadata?: JsonObject }
) {
  for (const field of datasetFields) {
    if (!schemas[field]?.enforced) continue
    const errors = datasetFieldErrors(
      schemas[field]?.schema,
      item[field] ?? (field === "metadata" ? {} : null)
    )
    if (errors.length)
      throw new Error(
        `${datasetFieldLabels[field]} does not match its enforced schema: ${errors.join("; ")}`
      )
  }
}

/** Infers a starting point from an example, which the user can refine before saving. */
export function inferDatasetSchema(value: JsonValue, depth = 0): JsonObject {
  if (depth > 12) return {}
  if (value === null) return { type: "null" }
  if (Array.isArray(value))
    return {
      type: "array",
      ...(value.length
        ? { items: inferDatasetSchema(value[0], depth + 1) }
        : {}),
    }
  if (typeof value === "object")
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          inferDatasetSchema(item ?? null, depth + 1),
        ])
      ),
      required: Object.keys(value),
    }
  return {
    type:
      typeof value === "number" && Number.isInteger(value)
        ? "integer"
        : typeof value,
  }
}

import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { DatasetItem, JsonValue } from "./contracts"
import { formatValueView, type ValueView } from "./value-views"

export type ValueDocument = { text: string; format: "json" | "yaml" | "text" }
export type ItemDraft = Record<
  "input" | "expectedOutput" | "metadata",
  ValueDocument
> & { sourceTraceId: string }
export const jsonDocument = (value: JsonValue): ValueDocument => ({
  text: JSON.stringify(value, null, 2),
  format: "json",
})
export const itemDraft = (item: DatasetItem): ItemDraft => ({
  input: jsonDocument(item.input),
  expectedOutput: jsonDocument(item.expectedOutput),
  metadata: jsonDocument(item.metadata),
  sourceTraceId: item.sourceTraceId ?? "",
})

function assertJson(
  value: unknown,
  seen = new Set<object>()
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (!value || typeof value !== "object" || seen.has(value))
    throw new Error(
      "Use JSON-compatible values without circular references or non-finite numbers."
    )
  seen.add(value)
  for (const child of Object.values(value)) assertJson(child, seen)
  seen.delete(value)
}

export function parseValueDocument(document: ValueDocument): JsonValue {
  if (document.format === "text") return document.text
  if (!document.text.trim()) return null
  const value: unknown =
    document.format === "yaml"
      ? parseYaml(document.text, { maxAliasCount: 50 })
      : JSON.parse(document.text)
  assertJson(value)
  return value
}

export function convertValueDocument(
  document: ValueDocument,
  format: ValueDocument["format"]
): ValueDocument {
  const value = parseValueDocument(document)
  if (format === "text" && typeof value !== "string")
    throw new Error(
      "Text editing is available for string values. Use JSON or YAML for structured data."
    )
  return {
    format,
    text:
      format === "text"
        ? (value as string)
        : format === "yaml"
          ? stringifyYaml(value)
          : JSON.stringify(value, null, 2),
  }
}

/** Viewing another format never mutates a draft or coerces structured data to text. */
export function documentForValueView(document: ValueDocument, view: ValueView) {
  if (view === document.format) return { document, readOnly: false }
  const parsed = parseValueDocument(document)
  if (
    view === "image" ||
    view === "pretty" ||
    view === "tree" ||
    view === "llm" ||
    view === "llm-raw"
  )
    return { document, readOnly: true }
  return {
    document: {
      format: view,
      text: formatValueView(parsed, view),
    } satisfies ValueDocument,
    readOnly: view === "text" && typeof parsed !== "string",
  }
}

export function parseItemDraft(draft: ItemDraft) {
  const input = parseValueDocument(draft.input)
  const expectedOutput = parseValueDocument(draft.expectedOutput)
  const metadata = parseValueDocument(draft.metadata)
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Metadata must be a JSON object.")
  return {
    input,
    expectedOutput,
    metadata,
    sourceTraceId: draft.sourceTraceId.trim() || null,
  }
}

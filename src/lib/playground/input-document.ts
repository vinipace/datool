import { stringify as stringifyYaml } from "yaml"
import { parseValueDocument } from "@/src/lib/tracer/dataset-editor"

export type InputFormat = "form" | "json" | "yaml" | "chat"
export type InputDocument =
  | { format: "form"; value: unknown }
  | { format: "chat"; value: unknown }
  | { format: "json" | "yaml"; text: string }

export function inputDocument(
  value: unknown,
  format: InputFormat
): InputDocument {
  if (format === "form" || format === "chat") return { format, value }
  return {
    format,
    text:
      format === "yaml" ? stringifyYaml(value) : JSON.stringify(value, null, 2),
  }
}

export function parseInputDocument(document: InputDocument) {
  const value =
    "value" in document ? document.value : parseValueDocument(document)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Input must be an object.")
  }
  return value
}

export function changeInputFormat(
  document: InputDocument,
  format: InputFormat
) {
  return document.format === format
    ? document
    : inputDocument(parseInputDocument(document), format)
}

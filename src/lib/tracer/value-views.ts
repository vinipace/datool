import { stringify as stringifyYaml } from "yaml"
import type { JsonValue } from "./contracts"
import { normaliseOutputMessages } from "./value-messages"
import { imageValue } from "./value-images"

export const valueViews = [
  "image",
  "llm",
  "llm-raw",
  "json",
  "yaml",
  "text",
  "pretty",
  "tree",
] as const
export type ValueView = (typeof valueViews)[number]
export const valueViewLabels: Record<ValueView, string> = {
  image: "Image",
  llm: "LLM",
  "llm-raw": "LLM Raw",
  json: "JSON",
  yaml: "YAML",
  text: "Text",
  pretty: "Pretty",
  tree: "Tree",
}

export function isMessageView(view: ValueView) {
  return view === "llm" || view === "llm-raw"
}

export function isReadOnlyValueView(view: ValueView) {
  return (
    isMessageView(view) ||
    view === "image" ||
    view === "pretty" ||
    view === "tree"
  )
}

/** Structured formats remain available for every value; chat needs explicit roles. */
export function availableValueViews(value: JsonValue): ValueView[] {
  const messages = normaliseOutputMessages(value)
  return valueViews.filter((view) =>
    view === "image"
      ? imageValue(value) !== null
      : !isMessageView(view) || messages !== null
  )
}

export function defaultValueView(value: JsonValue): ValueView {
  if (imageValue(value)) return "image"
  if (normaliseOutputMessages(value)) return "llm"
  return typeof value === "string" ? "text" : "json"
}

export function resolveValueView(
  value: JsonValue,
  requested?: ValueView
): ValueView {
  return requested && availableValueViews(value).includes(requested)
    ? requested
    : defaultValueView(value)
}

export function isValueView(value: string): value is ValueView {
  return valueViews.some((view) => view === value)
}

export function formatValueView(
  value: JsonValue,
  view: ValueView,
  compact = false
) {
  if (view === "yaml") return stringifyYaml(value)
  if (view === "text" && typeof value === "string") return value
  return JSON.stringify(value, null, compact && view === "json" ? 0 : 2)
}

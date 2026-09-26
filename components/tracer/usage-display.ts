import type { JsonObject } from "@/src/lib/tracer/contracts"
import { readModel, readUsage } from "@/src/lib/tracer/usage"

export function usageDisplay(attributes: JsonObject): [string, string][] {
  const usage = readUsage(attributes)
  const models = Array.isArray(attributes.models)
    ? attributes.models.filter((value) => typeof value === "string")
    : []
  const model = models.length ? models.join(", ") : readModel(attributes)
  const rows: [string, string][] = model
    ? [[models.length > 1 ? "Models" : "Model", model]]
    : []
  const partial = attributes["usage.status"] === "partial" ? " (partial)" : ""
  for (const [label, value] of [
    ["Input tokens", usage.input],
    ["Output tokens", usage.output],
    ["Total tokens", usage.total],
    ["Cached input tokens", usage.cacheRead],
    ["Cache write tokens", usage.cacheWrite],
    ["Reasoning tokens", usage.reasoning],
  ] as const) {
    if (value !== undefined)
      rows.push([label, `${value.toLocaleString()}${partial}`])
  }
  const cost = attributes["cost.usd"] ?? attributes["cost.known_usd"]
  const estimated =
    attributes["cost.status"] === "estimated" ||
    attributes["cost.source"] === "descendant_llm_sum"
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    rows.push([
      estimated ? "Estimated cost" : "Reported cost",
      `$${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}${attributes["cost.status"] === "partial" ? " (partial)" : ""}`,
    ])
  }
  return rows
}

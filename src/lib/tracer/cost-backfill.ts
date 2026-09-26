import type { JsonObject } from "./contracts.ts"
import type { PricingSnapshot } from "./pricing-catalog.ts"
import { priceLlm } from "./pricing.ts"
import { aggregateLlmUsage, readModel, withTrackingMetrics } from "./usage.ts"

export type CostBackfillSpan = {
  id: string
  parentId: string | null
  kind: string
  attributes: JsonObject
}

/** Pure plan: price only the selected model's missing quotes. Wrappers are
 * recalculated from descendant LLM facts, including previously priced calls. */
export function planCostBackfill(
  trace: JsonObject,
  spans: CostBackfillSpan[],
  snapshot: PricingSnapshot,
  model: string,
  runId: string
) {
  const changed = new Map<string, JsonObject>()
  const byId = new Map(spans.map((span) => [span.id, span]))
  const parents = new Set<string>()
  let priced = 0
  let addedUsd = 0
  for (const span of spans) {
    if (
      span.kind !== "llm" ||
      readModel(span.attributes) !== model ||
      span.attributes["cost.status"] !== "missing"
    )
      continue
    const quote = priceLlm(span.attributes, snapshot.providers, snapshot)
    if (quote["cost.status"] !== "estimated") continue
    changed.set(span.id, { ...quote, "cost.backfill_id": runId })
    priced++
    addedUsd += Number(quote["cost.usd"])
    const visited = new Set([span.id])
    let parent = span.parentId
    while (parent && byId.has(parent)) {
      if (visited.has(parent)) throw new Error("Cyclic span ancestry")
      visited.add(parent)
      parents.add(parent)
      parent = byId.get(parent)!.parentId
    }
  }
  if (!priced) return { changed, trace: undefined, priced, addedUsd }
  const llms = spans.filter((span) => span.kind === "llm")
  for (const id of parents) {
    const parent = byId.get(id)!
    if (parent.kind === "llm") continue
    const descendants = llms.filter((span) => {
      const visited = new Set<string>()
      let ancestor = span.parentId
      while (ancestor && byId.has(ancestor)) {
        if (visited.has(ancestor)) throw new Error("Cyclic span ancestry")
        visited.add(ancestor)
        if (ancestor === id) return true
        ancestor = byId.get(ancestor)!.parentId
      }
      return false
    })
    changed.set(
      id,
      rollup(
        parent.attributes,
        descendants.map((span) => changed.get(span.id) ?? span.attributes),
        runId
      )
    )
  }
  return {
    changed,
    trace: rollup(
      trace,
      llms.map((span) => changed.get(span.id) ?? span.attributes),
      runId
    ),
    priced,
    addedUsd,
  }
}

function rollup(attributes: JsonObject, llms: JsonObject[], runId: string) {
  const result = { ...attributes }
  // Retain metadata and token usage. Only the inclusive cost projection changes.
  for (const key of Object.keys(result))
    if (key.startsWith("cost.")) delete result[key]
  const totals = aggregateLlmUsage(llms)
  for (const [key, value] of Object.entries(totals))
    if (key.startsWith("cost.")) result[key] = value
  result["cost.backfill_id"] = runId
  return withTrackingMetrics(result)
}

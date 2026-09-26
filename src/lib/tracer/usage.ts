import type { JsonObject } from "./contracts.ts"

export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function firstCount(a: JsonObject, ...keys: string[]) {
  for (const key of keys) {
    const value = tokenCount(a[key])
    if (value !== undefined) return value
  }
}

export function readUsage(a: JsonObject) {
  const input = firstCount(
    a,
    "usage.input_tokens",
    "gen_ai.usage.input_tokens",
    "ai.usage.inputTokens"
  )
  const output = firstCount(
    a,
    "usage.output_tokens",
    "gen_ai.usage.output_tokens",
    "ai.usage.outputTokens"
  )
  return {
    input,
    output,
    total:
      input !== undefined && output !== undefined
        ? input + output
        : firstCount(a, "usage.total_tokens", "ai.usage.totalTokens"),
    cacheRead: firstCount(
      a,
      "usage.cache_read_tokens",
      "gen_ai.usage.cache_read.input_tokens",
      "ai.usage.inputTokenDetails.cacheReadTokens",
      "ai.usage.cachedInputTokens"
    ),
    cacheWrite: firstCount(
      a,
      "usage.cache_write_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      "ai.usage.inputTokenDetails.cacheWriteTokens"
    ),
    reasoning: firstCount(
      a,
      "usage.reasoning_tokens",
      "gen_ai.usage.reasoning.output_tokens",
      "ai.usage.outputTokenDetails.reasoningTokens",
      "ai.usage.reasoningTokens"
    ),
  }
}

export function usageAttributes(
  usage: ReturnType<typeof readUsage>
): JsonObject {
  return Object.fromEntries(
    Object.entries({
      "usage.input_tokens": usage.input,
      "usage.output_tokens": usage.output,
      "usage.total_tokens": usage.total,
      "usage.cache_read_tokens": usage.cacheRead,
      "usage.cache_write_tokens": usage.cacheWrite,
      "usage.reasoning_tokens": usage.reasoning,
    }).filter(([, value]) => value !== undefined)
  ) as JsonObject
}

/** Nested projection for saved-view selectors and collection filters. */
export function withTrackingMetrics(attributes: JsonObject): JsonObject {
  const usage = readUsage(attributes)
  const existing = attributes.metrics
  const metrics: JsonObject =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {}
  const values = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.total,
    cachedInputTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning,
    costUsd: attributes["cost.usd"],
    knownCostUsd: attributes["cost.known_usd"],
    usageStatus: attributes["usage.status"],
    costStatus: attributes["cost.status"],
    llmCalls: attributes["usage.llm_calls"],
    models: attributes.models ?? (attributes.model ? [attributes.model] : []),
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete metrics[key]
    else metrics[key] = value
  }
  return { ...attributes, metrics }
}

export const recordedModelKeys = [
  "gen_ai.response.model",
  "ai.response.model",
  "gen_ai.request.model",
  "ai.model.id",
  "model",
] as const

export function readModel(a: JsonObject): string | undefined {
  for (const key of recordedModelKeys) {
    if (typeof a[key] === "string" && a[key].trim()) return a[key]
  }
}

/** Aggregate only billable LLM spans, never wrapper usage or wrapper totals. */
export function aggregateLlmUsage(llms: JsonObject[]): JsonObject {
  const usages = llms.map(readUsage)
  const known = usages.filter(
    (u) => u.input !== undefined && u.output !== undefined
  ).length
  const sum = (key: keyof ReturnType<typeof readUsage>) => {
    const values = usages.flatMap((u) =>
      u[key] === undefined ? [] : [u[key]!]
    )
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined
  }
  const costs = llms.flatMap((a) =>
    typeof a["cost.usd"] === "number" &&
    Number.isFinite(a["cost.usd"]) &&
    a["cost.usd"] >= 0 &&
    a["cost.status"] !== "missing" &&
    a["cost.status"] !== "partial"
      ? [a["cost.usd"] as number]
      : []
  )
  const models = [
    ...new Set(llms.flatMap((a) => (readModel(a) ? [readModel(a)!] : []))),
  ]
  const providers = [
    ...new Set(
      llms.flatMap((a) => (typeof a.provider === "string" ? [a.provider] : []))
    ),
  ]
  const totalCost = costs.reduce((a, b) => a + b, 0)
  return withTrackingMetrics({
    ...usageAttributes({
      input: sum("input"),
      output: sum("output"),
      total: sum("total"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
      reasoning: sum("reasoning"),
    }),
    "usage.source": "descendant_llm_sum",
    "usage.llm_calls": llms.length,
    "usage.known_llm_calls": known,
    "usage.status": !known
      ? "missing"
      : known === llms.length
        ? "complete"
        : "partial",
    models,
    providers,
    ...(models.length === 1 ? { model: models[0] } : {}),
    "cost.status": !costs.length
      ? "missing"
      : costs.length === llms.length
        ? "estimated"
        : "partial",
    "cost.priced_llm_calls": costs.length,
    ...(costs.length ? { "cost.known_usd": totalCost } : {}),
    ...(costs.length && costs.length === llms.length
      ? { "cost.usd": totalCost }
      : {}),
    "cost.source": "descendant_llm_sum",
  })
}

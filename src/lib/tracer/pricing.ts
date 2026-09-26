import { getTokenCosts, type ModelCatalog } from "tokenlens"
import { getModels } from "tokenlens/models"
import type { JsonObject } from "./contracts.ts"
import {
  defaultPricingCatalog,
  type PricingCatalog,
  type PricingSnapshot,
} from "./pricing-catalog.ts"
import {
  readModel,
  readUsage,
  usageAttributes,
  withTrackingMetrics,
} from "./usage.ts"

const catalog: ModelCatalog = getModels()

export async function priceLlmWithCatalog(
  attributes: JsonObject,
  pricing: PricingCatalog = defaultPricingCatalog
): Promise<JsonObject> {
  const snapshot = await pricing.get()
  return priceLlm(attributes, snapshot.providers, snapshot)
}

/** Persist the quote and rates at ingestion; historical traces are not repriced. */
export function priceLlm(
  attributes: JsonObject,
  providers: ModelCatalog = catalog,
  snapshot?: Pick<PricingSnapshot, "source" | "fetchedAt">
): JsonObject {
  const usage = readUsage(attributes)
  const model = readModel(attributes)
  const rawProvider =
    attributes["gen_ai.provider.name"] ??
    attributes["ai.model.provider"] ??
    attributes.provider
  const provider =
    typeof rawProvider === "string" ? rawProvider.split(".")[0] : undefined
  const base: JsonObject = {
    ...attributes,
    ...usageAttributes(usage),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    "usage.source": "provider",
    "usage.status":
      usage.input !== undefined && usage.output !== undefined
        ? "complete"
        : "missing",
    "cost.source": "tokenlens",
    "cost.status": "missing",
    "cost.tokenlens_version": "1.3.1",
    "cost.catalog": snapshot?.source ?? "tokenlens/models (models.dev)",
    ...(snapshot?.fetchedAt
      ? { "cost.catalog_fetched_at": snapshot.fetchedAt }
      : {}),
  }
  // Repricing a missing quote must not retain stale amounts or failure reasons.
  for (const key of [
    "cost.usd",
    "cost.known_usd",
    "cost.reason",
    "cost.breakdown",
    "cost.rates_per_million",
    "cost.calculated_at",
    "cost.context_threshold",
  ])
    delete base[key]
  const missing = (reason: string) =>
    withTrackingMetrics({ ...base, "cost.reason": reason })
  if (!provider || !model) return missing("Missing provider or model")
  if (usage.input === undefined || usage.output === undefined)
    return missing("Missing provider input/output usage")
  const p = providers[provider]
  // Dated OpenAI snapshots may be priced by their matching undated model.
  // Preserve the exact response model separately from the pricing identity.
  const id = p?.models[model]
    ? model
    : provider === "openai"
      ? model.replace(/-\d{4}-\d{2}-\d{2}$/, "")
      : model
  const entry = p?.models[id]
  const selected = contextRates(entry?.cost, usage.input)
  const rates = selected?.rates
  if (!entry || !rates || !validRate(rates.input) || !validRate(rates.output))
    return missing("Model rates unavailable in TokenLens")
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const reasoning = usage.reasoning ?? 0
  if (cacheRead + cacheWrite > usage.input || reasoning > usage.output)
    return missing("Invalid token detail counts")
  if (
    (cacheRead && !validRate(rates.cache_read)) ||
    (cacheWrite && !validRate(rates.cache_write)) ||
    (rates.reasoning !== undefined && !validRate(rates.reasoning))
  )
    return missing("Cache rate unavailable in TokenLens")
  // Provider totals include cached input and reasoning output. TokenLens adds
  // separately priced buckets, so subtract them first to avoid double billing.
  // Scope the catalog to one provider: TokenLens 1.3.1 can otherwise resolve a
  // same-name model from a different provider (including free gateway entries).
  const costs = getTokenCosts({
    modelId: `${provider}/${id}`,
    providers: {
      [provider]: { ...p, models: { [id]: { ...entry, cost: rates } } },
    },
    usage: {
      input: usage.input - cacheRead - cacheWrite,
      output: usage.output - (rates.reasoning !== undefined ? reasoning : 0),
      cacheReads: cacheRead,
      cacheWrites: cacheWrite,
      ...(rates.reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    },
  })
  if (
    costs.totalUSD === undefined ||
    !Number.isFinite(costs.totalUSD) ||
    costs.totalUSD < 0
  )
    return missing("TokenLens returned no estimate")
  return withTrackingMetrics({
    ...base,
    "cost.status": "estimated",
    "cost.usd": costs.totalUSD,
    "cost.model": `${provider}/${id}`,
    "cost.resolution": id === model ? "exact" : "dated_snapshot_alias",
    "cost.rates_per_million": { ...rates },
    ...(selected.threshold !== undefined
      ? { "cost.context_threshold": selected.threshold }
      : {}),
    "cost.breakdown": JSON.parse(JSON.stringify(costs)),
    "cost.calculated_at": new Date().toISOString(),
  })
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

type Rates = NonNullable<ModelCatalog[string]["models"][string]["cost"]>

/** TokenLens 1.3.1 ignores context tiers. Select by total input, before removing
 * cache tokens, and apply the selected rates to the entire request. */
function contextRates(
  cost: Rates | undefined,
  input: number | undefined
): { rates: Rates; threshold?: number } | undefined {
  if (!cost) return undefined
  const raw = cost as Rates & { tiers?: unknown; context_over_200k?: unknown }
  const { tiers, context_over_200k: legacy, ...base } = raw
  let rates = base as Rates
  let threshold: number | undefined
  if (Array.isArray(tiers)) {
    for (const candidate of tiers) {
      const tier = candidate?.tier
      if (tier?.type !== "context" || !validRate(tier.size)) continue
      if (
        input !== undefined &&
        input > tier.size &&
        (threshold === undefined || tier.size > threshold)
      ) {
        const override = { ...candidate }
        delete override.tier
        rates = { ...base, ...override }
        threshold = tier.size
      }
    }
  } else if (
    legacy &&
    typeof legacy === "object" &&
    input !== undefined &&
    input > 200_000
  ) {
    rates = { ...base, ...legacy }
    threshold = 200_000
  }
  return { rates, threshold }
}

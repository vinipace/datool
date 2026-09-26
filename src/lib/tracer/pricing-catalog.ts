import { fetchModels } from "tokenlens/fetch"
import { getModels } from "tokenlens/models"
import type { ModelCatalog } from "tokenlens"

export type PricingCatalogOptions = {
  /** Disable network refreshes for offline applications and deterministic tests. */
  autoRefresh?: boolean
  /** A fallback or custom catalog. Defaults to TokenLens's bundled snapshot. */
  catalog?: ModelCatalog
  /** Catalog transport only; never receives Datool credentials or trace data. */
  fetch?: typeof globalThis.fetch
  refreshIntervalMs?: number
  timeoutMs?: number
}

export type PricingSnapshot = {
  providers: ModelCatalog
  source: string
  fetchedAt?: string
}

/** One bounded, shared refresh per interval; retain the last good snapshot. */
export class PricingCatalog {
  private snapshot: PricingSnapshot
  private nextRefresh = 0
  private pending?: Promise<PricingSnapshot>

  constructor(private readonly options: PricingCatalogOptions = {}) {
    this.snapshot = {
      providers: options.catalog ?? getModels(),
      source: options.catalog ? "custom" : "tokenlens/models (models.dev)",
    }
  }

  async get(): Promise<PricingSnapshot> {
    if (this.pending) return this.pending
    if (this.options.autoRefresh === false || Date.now() < this.nextRefresh)
      return this.snapshot
    this.pending = this.refresh()
    try {
      return await this.pending
    } finally {
      this.pending = undefined
    }
  }

  private async refresh(): Promise<PricingSnapshot> {
    try {
      const providers = await fetchModels({
        fetch: (url, init) =>
          (this.options.fetch ?? globalThis.fetch)(url, init as RequestInit),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      })
      if (!validCatalog(providers)) throw new Error("Invalid pricing catalog")
      this.snapshot = {
        providers,
        source: "https://models.dev/api.json",
        fetchedAt: new Date().toISOString(),
      }
      this.nextRefresh =
        Date.now() + (this.options.refreshIntervalMs ?? 3_600_000)
    } catch {
      // A catalog outage must not prevent traces from being delivered. Retry
      // after a minute instead of making every LLM span retry the same outage.
      this.nextRefresh = Date.now() + 60_000
    }
    return this.snapshot
  }
}

function validCatalog(value: unknown): value is ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const providers = Object.values(value)
  return (
    providers.length > 0 &&
    providers.every(
      (provider) =>
        provider &&
        typeof provider === "object" &&
        typeof provider.id === "string" &&
        provider.models &&
        typeof provider.models === "object" &&
        !Array.isArray(provider.models)
    )
  )
}

export const defaultPricingCatalog = new PricingCatalog()

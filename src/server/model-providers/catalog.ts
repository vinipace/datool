import { z } from "zod"
import type { ModelCatalog } from "@/src/lib/model-providers"

const rate = z
  .string()
  .refine(
    (value) =>
      value.trim() !== "" &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0
  )
const tiers = z
  .array(
    z.object({
      cost: rate,
      min: z.number().nonnegative(),
      max: z.number().nonnegative().optional(),
    })
  )
  .optional()
  .catch(undefined)

const modelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1),
  owned_by: z.string(),
  type: z.string(),
  context_window: z.number().optional(),
  description: z.string().max(16000).optional().catch(undefined),
  max_tokens: z.number().nonnegative().optional().catch(undefined),
  modalities: z
    .object({ input: z.array(z.string()), output: z.array(z.string()) })
    .optional()
    .catch(undefined),
  pricing: z
    .object({
      input: rate.optional().catch(undefined),
      output: rate.optional().catch(undefined),
      input_cache_read: rate.optional().catch(undefined),
      input_tiers: tiers,
      output_tiers: tiers,
    })
    .optional()
    .catch(undefined),
  tags: z.array(z.string()).default([]),
})

/** Public metadata only. Credentials and project data never leave this server. */
export function createGatewayCatalog(
  fetcher: typeof fetch = fetch,
  now = Date.now
) {
  let cached: ModelCatalog | undefined
  let retryAt = 0
  let pending: Promise<ModelCatalog> | undefined
  async function refresh(): Promise<ModelCatalog> {
    try {
      const response = await fetcher("https://ai-gateway.vercel.sh/v1/models", {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
        cache: "no-store",
      })
      if (!response.ok) throw new Error()
      const body = z
        .object({ data: z.array(z.unknown()).max(10000) })
        .parse(await response.json())
      const models = body.data
        .flatMap((item) => {
          const parsed = modelSchema.safeParse(item)
          if (!parsed.success) return []
          const model = parsed.data
          return [
            {
              id: model.id,
              name: model.name,
              creator: model.owned_by,
              type: model.type,
              contextWindow: model.context_window,
              description: model.description,
              maxOutputTokens: model.max_tokens,
              modalities: model.modalities,
              pricing: model.pricing
                ? {
                    input: model.pricing.input,
                    output: model.pricing.output,
                    cacheRead: model.pricing.input_cache_read,
                    inputTiers: model.pricing.input_tiers,
                    outputTiers: model.pricing.output_tiers,
                  }
                : undefined,
              tags: model.tags,
            },
          ]
        })
        .sort(
          (a, b) =>
            a.creator.localeCompare(b.creator) || a.name.localeCompare(b.name)
        )
      if (!models.length) throw new Error()
      cached = {
        models,
        fetchedAt: new Date(now()).toISOString(),
        stale: false,
      }
      retryAt = now() + 60 * 60 * 1000
      return cached
    } catch {
      retryAt = now() + 60000
      if (cached) return { ...cached, stale: true }
      throw new Error("Unable to load the model catalog. Try again shortly.")
    }
  }
  return async (): Promise<ModelCatalog> => {
    if (cached && now() < retryAt)
      return {
        ...cached,
        stale: now() - Date.parse(cached.fetchedAt) >= 60 * 60 * 1000,
      }
    if (!cached && now() < retryAt)
      throw new Error("Unable to load the model catalog. Try again shortly.")
    if (!pending)
      pending = refresh().finally(() => {
        pending = undefined
      })
    return pending
  }
}

export const getGatewayCatalog = createGatewayCatalog()

import { after } from "next/server"
import { z } from "zod"
import { api, readJson } from "@/src/server/tracer/http"
import { runTracerEffect, tracerEffect } from "@/src/server/tracer/effect"
import { withWorkspace } from "@/src/server/auth/context"
import {
  semanticErrorToTracerError,
  toSemanticServiceError,
} from "@/src/server/semantic/errors"
import { validation } from "@/src/server/tracer/errors"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { validateSemanticQuery } from "@/src/server/semantic/executor"
import { dashboardCachePlan } from "@/src/lib/tracer/dashboard-cache"
import { SEMANTIC_CONTRACT_VERSION } from "@/src/lib/semantic/query"
import { routeSwrCache } from "@/src/server/cache/redis"
import type { CacheState } from "@/src/server/cache/stale-while-revalidate"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const inputSchema = z
  .object({
    queries: z.array(z.unknown()).min(1).max(40),
    cache: z
      .object({
        dateFilter: z.string().max(4000),
        rangeEnd: z.number().finite(),
        force: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export async function POST(request: Request) {
  let cacheState: CacheState = "bypass"
  // api() authorizes project access and scopes the service before any cache read.
  const response = await api(request, async (service, context) => {
    const parsed = inputSchema.safeParse(await readJson(request))
    if (!parsed.success) throw validation("Invalid metrics batch.")
    const { cache, queries: input } = parsed.data
    const queries = input.map((query) => {
      try {
        return validateSemanticQuery(query, semanticCatalog)
      } catch (error) {
        throw semanticErrorToTracerError(toSemanticServiceError(error))
      }
    })
    let plan: ReturnType<typeof dashboardCachePlan> = null
    if (cache) {
      try {
        plan = dashboardCachePlan(queries, cache)
      } catch {
        /* Ineligible requests use the uncached path. */
      }
    }
    if (!plan) return service.batchSemanticMetrics({ queries })
    const cachedPlan = plan
    return tracerEffect(async () => {
      const result = await routeSwrCache()({
        namespace: "dashboard-metrics-v1",
        scope: context.projectId,
        key: {
          contract: SEMANTIC_CONTRACT_VERSION,
          catalog: semanticCatalog.metadata(),
          ...cachedPlan.key,
        },
        freshMs: 60_000,
        maxAgeMs: 15 * 60_000,
        force: cache?.force,
        defer: after,
        load: () =>
          withWorkspace(context.identity, () =>
            runTracerEffect(
              service.batchSemanticMetrics({ queries: cachedPlan.queries })
            )
          ),
      })
      cacheState = result.state
      return result.data
    })
  })
  response.headers.set("X-Datool-Cache", cacheState)
  return response
}

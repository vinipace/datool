import { sql } from "drizzle-orm"
import type {
  NormalizedSemanticQuery,
  SemanticFilter,
} from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import { traces } from "../tracer/schema"
import { snapshotQueries } from "../semantic/batch-plan"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "../semantic/sql-filters"
import { metricWindow } from "./common"

export type TraceScalarFacts = Record<string, number | null>
const cache = new WeakMap<object, Map<string, Promise<TraceScalarFacts>>>()
export const scalarQuery = (query: NormalizedSemanticQuery) =>
  !query.dimensions.length && !query.timeDimensions.some((t) => t.granularity)
function population(query: NormalizedSemanticQuery) {
  const model = query.measures[0].split(".")[0]
  if (!["traces", "logs"].includes(model) || !scalarQuery(query)) return null
  if (
    model === "logs" &&
    !query.measures.some((m) =>
      ["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
    )
  )
    return null
  const filters = (items: readonly SemanticFilter[]): unknown[] =>
    items.map((f) =>
      "member" in f
        ? { ...f, member: f.member.replace(/^(traces|logs)\./, "") }
        : "and" in f
          ? { and: filters(f.and) }
          : { or: filters(f.or) }
    )
  const window = metricWindow(query, `${model}.startedAt`)
  return JSON.stringify({
    from: window.fromMs,
    to: window.toMs,
    filters: filters(query.filters),
  })
}
/** Traces and logs latency share the same persisted terminal-trace population. */
export async function traceScalarFacts(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext,
  fields: Record<string, SqlFilterField>
): Promise<TraceScalarFacts> {
  const key = population(query)!
  let values = cache.get(context.snapshot)
  if (!values) {
    values = new Map()
    cache.set(context.snapshot, values)
  }
  const prepared = [
    query,
    ...snapshotQueries(context.snapshot).filter((q) => population(q) === key),
  ]
  const measures = prepared.flatMap((q) => q.measures)
  const percentile = measures.some((m) =>
    ["traces.p95DurationMs", "logs.p95LatencyMs"].includes(m)
  )
  const costing = measures.includes("traces.reportedCostUsd")
  const cacheKey = `${key}:${percentile}:${costing}`
  const existing = values.get(cacheKey)
  if (existing) return existing
  const model = query.measures[0].split(".")[0],
    window = metricWindow(query, `${model}.startedAt`)
  const promise = (async () => {
    const result = await context.snapshot.execute(sql`select count(*) as count,
      count(*) filter(where status='completed') as "completedCount",count(*) filter(where status='errored') as "erroredCount",
      count(*) filter(where status='cancelled') as "cancelledCount",count(*) filter(where status='running') as "runningCount",
      count(*) filter(where status='errored')::double precision / nullif(count(*) filter(where status in ('completed','errored')),0) as "errorRate",
      count(duration_ms) as "durationSampleCount",avg(duration_ms) as "meanDurationMs",
      ${percentile ? sql`percentile_disc(0.95) within group(order by duration_ms)` : sql`null::double precision`} as "p95DurationMs",
      ${costing ? sql`sum(cost_usd)` : sql`null::double precision`} as "reportedCostUsd",
      count(*) filter(where status in ('completed','errored','cancelled') and duration_ms is null) as "invalidDuration",
      count(*) filter(where status not in ('completed','errored','cancelled','running')) as "invalidStatus",
      ${costing ? sql`count(*) filter(where cost_usd is null)` : sql`0`} as "missingCost",
      ${costing ? sql`count(*) filter(where cost_status='estimated')` : sql`0`} as "estimatedCost"
      from ${traces} where ${traces.projectId}=${context.snapshot.projectId} and ${traces.startedAtMs}>=${window.fromMs} and ${traces.startedAtMs}<${window.toMs}
      and ${semanticSqlFilters(query.filters, fields)}`)
    const invalid = await context.snapshot.execute(
      sql`select count(*) as count from ${traces} where ${traces.projectId}=${context.snapshot.projectId} and ${traces.startedAtMs} is null and ${semanticSqlFilters(query.filters, fields)}`
    )
    return {
      ...Object.fromEntries(
        Object.entries(result.rows[0]).map(([key, value]) => [
          key,
          value === null ? null : Number(value),
        ])
      ),
      invalidTime: Number(invalid.rows[0].count),
    }
  })()
  values.set(cacheKey, promise)
  return promise
}
export function traceScalarWarnings(facts: TraceScalarFacts, costing: boolean) {
  return [
    [
      facts.invalidDuration,
      "terminal trace row(s) had no valid persisted duration sample.",
    ],
    [
      facts.invalidStatus,
      "trace row(s) used an unrecognized persisted lifecycle status.",
    ],
    ...(costing
      ? [
          [
            facts.estimatedCost,
            "trace cost(s) are estimates, not invoiced amounts.",
          ],
          [
            facts.missingCost,
            "trace(s) in this time window have no complete cost report; their costs are unknown.",
          ],
        ]
      : []),
    [
      facts.invalidTime,
      "persisted trace row(s) had an invalid startedAt and were excluded.",
    ],
  ].flatMap(([count, message]) => (count ? [`${count} ${message}`] : []))
}

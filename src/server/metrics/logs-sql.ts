import { scalarQuery, traceScalarFacts } from "./trace-scalar-facts"
import { recordedModelKeys } from "@/src/lib/tracer/usage"
import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import {
  SemanticModelQueryError,
  type SemanticExecutionContext,
} from "@/src/lib/semantic/model"
import { spans, traces } from "@/src/server/tracer/schema"
import { safeJson, semanticSqlFilters } from "@/src/server/semantic/sql-filters"
import { executeSqlPage } from "@/src/server/semantic/sql-page"
import { traceSqlFields } from "./trace-fields"
import { metricWindow, type MetricWindow } from "./common"
import {
  costAttributionMembers,
  costAttributionSql,
} from "./cost-attribution-sql"

/** Partition the bounded interval at real IANA calendar boundaries, including DST. */
export function calendarBuckets(window: MetricWindow) {
  const buckets: { day: string; from: number; to: number }[] = []
  let start = window.fromMs
  while (start < window.toMs) {
    const day = window.formatDay(start)
    let probe = Math.min(start + 6 * 3600000, window.toMs)
    while (probe < window.toMs && window.formatDay(probe) === day)
      probe = Math.min(probe + 6 * 3600000, window.toMs)
    let low = start,
      high = probe
    if (window.formatDay(probe - 1) !== day) {
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2)
        if (window.formatDay(mid) === day) low = mid
        else high = mid
      }
      probe = high
    }
    buckets.push({ day, from: start, to: probe })
    start = probe
  }
  return buckets
}

const attribute = (doc: SQL, key: string) => sql`(${doc} ->> ${key})`
const llmMeasures = new Set([
  "logs.llmCount",
  "logs.pricedLlmCount",
  "logs.unpricedLlmCount",
  "logs.costCoverage",
  "logs.meanLlmCostUsd",
  "logs.costUsd",
  "logs.inputCostUsd",
  "logs.outputCostUsd",
  "logs.cacheCostUsd",
  "logs.tokenCount",
  "logs.inputTokens",
  "logs.outputTokens",
  "logs.cacheTokens",
  "logs.meanTtftMs",
  "logs.p95TtftMs",
])
function nonnegative(doc: SQL, key: string, integer = false): SQL {
  const value = attribute(doc, key)
  const kind = sql`jsonb_typeof(${doc} -> ${key})`
  return sql`case when ${kind} = 'number' then case when (${value})::numeric >= 0 and (${value})::numeric <= ${integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE} ${integer ? sql`and (${value})::numeric = trunc((${value})::numeric)` : sql``} then (${value})::double precision end end`
}
/** One canonical cost eligibility rule for totals, breakdowns, and rankings. */
export function llmCostSql(doc: SQL) {
  const valid = sql`coalesce(${attribute(doc, "cost.status")}, '') not in ('missing', 'partial') and ${nonnegative(doc, "cost.usd")} is not null`
  const component = (key: string) =>
    sql`case when ${valid} then ${nonnegative(safeJson(attribute(doc, "cost.breakdown")), key)} end`
  return {
    total: sql`case when ${valid} then ${nonnegative(doc, "cost.usd")} end`,
    input: component("inputUSD"),
    output: component("outputUSD"),
    cacheRead: component("cacheReadsUSD"),
    cacheWrite: component("cacheWritesUSD"),
  }
}

export async function executeLogsSql(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
): Promise<{
  rows: import("@/src/lib/semantic/result").SemanticDataRow[]
  paged: true
  total?: number
}> {
  const window = metricWindow(query, "logs.startedAt")
  const buckets = calendarBuckets(window)
  const groupDay = (timestamp: SQL) =>
    window.hasDayGrain
      ? sql`case ${sql.join(
          buckets.map(
            (b) =>
              sql`when ${timestamp} >= ${b.from} and ${timestamp} < ${b.to} then ${b.day}`
          ),
          sql` `
        )} end`
      : sql`${"all"}`
  const inWindow = (timestamp: SQL) =>
    sql`${timestamp} >= ${window.fromMs} and ${timestamp} < ${window.toMs}`
  const cost = {
    total: sql`${spans.costUsd}`,
    input: sql`${spans.inputCostUsd}`,
    output: sql`${spans.outputCostUsd}`,
    cacheRead: sql`${spans.cacheReadCostUsd}`,
    cacheWrite: sql`${spans.cacheWriteCostUsd}`,
  }
  const input = sql`${spans.inputTokens}`,
    output = sql`${spans.outputTokens}`,
    cached = sql`${spans.cachedTokens}`,
    written = sql`${spans.writtenTokens}`
  const total = sql`coalesce(${input} + ${output}, ${spans.reportedTotalTokens})`
  const ttft = sql`${spans.ttftMs}`
  const attribution = costAttributionSql(query)
  // Positive LLM-only groups cannot contain contributions from other span kinds.
  // Filter those rows before walking ancestry; retain all ancestors in the join.
  // Without this HAVING guarantee, zero/null groups must remain visible.
  const onlyLlmFacts =
    query.measures.every((m) => llmMeasures.has(m)) &&
    query.having?.some(
      (filter) =>
        "member" in filter &&
        llmMeasures.has(filter.member) &&
        filter.operator === "gt" &&
        typeof filter.values?.[0] === "number" &&
        filter.values[0] >= 0
    )
  const fields = {
    ...attribution.fields,
    ...traceSqlFields("logs"),
    "logs.trace": {
      value: sql`${traces.name} || ' · ' || ${traces.id}`,
      type: "string" as const,
    },
    "logs.traceName": {
      value: sql`${traces.name}`,
      type: "string" as const,
      caseSensitive: true,
    },
    "logs.spanName": {
      value: sql`${spans.name}`,
      type: "string" as const,
      caseSensitive: true,
    },
    "logs.spanStatus": { value: sql`${spans.status}`, type: "string" as const },
    "logs.model": {
      value: sql`coalesce(${sql.join(
        recordedModelKeys.map(
          (key) =>
            sql`case when jsonb_typeof(${spans.attributesJson} -> ${key}) = 'string' and (${spans.attributesJson} ->> ${key}) !~ '^[[:space:]]*$' then ${spans.attributesJson} ->> ${key} end`
        ),
        sql`, `
      )})`,
      type: "string" as const,
      caseSensitive: true,
    },
    "logs.errorType": {
      value: sql`coalesce(nullif(${spans.attributesJson} ->> 'error.type', ''), nullif(${spans.attributesJson} ->> 'error.name', ''), nullif(${spans.attributesJson} ->> 'exception.type', ''))`,
      type: "string" as const,
      caseSensitive: true,
    },
    "logs.errorMessage": {
      value: sql`coalesce(nullif(${spans.attributesJson} ->> 'error.message', ''), nullif(${spans.attributesJson} ->> 'exception.message', ''))`,
      type: "string" as const,
      caseSensitive: true,
    },
    "logs.spanCostUsd": {
      value: sql`case when ${spans.kind} = 'llm' then ${cost.total} end`,
      type: "number" as const,
    },
    "logs.hasCost": {
      value: sql`case when ${spans.kind} = 'llm' and ${cost.total} is not null then 'yes' else 'no' end`,
      type: "string" as const,
    },
  }
  const predicate = semanticSqlFilters(query.filters, fields)
  const spanFilterMembers = new Set([
    ...costAttributionMembers,
    "logs.hasCost",
    "logs.spanCostUsd",
    "logs.spanName",
    "logs.spanStatus",
    "logs.model",
    "logs.errorType",
    "logs.errorMessage",
  ])
  const hasSpanFilter = (filters: typeof query.filters): boolean =>
    filters.some((f) =>
      "member" in f
        ? spanFilterMembers.has(f.member)
        : hasSpanFilter("and" in f ? f.and : f.or)
    )
  const latencyRequested = query.measures.some(
    (m) => m === "logs.meanLatencyMs" || m === "logs.p95LatencyMs"
  )
  if (
    latencyRequested &&
    (query.dimensions.some((d) => spanFilterMembers.has(d)) ||
      hasSpanFilter(query.filters))
  )
    throw new SemanticModelQueryError(
      "MODEL_QUERY_INVALID",
      "Span-level grouping and filters cannot be used with trace latency."
    )
  if (latencyRequested && scalarQuery(query) && !query.having?.length) {
    const facts = await traceScalarFacts(query, context, fields)
    const spanMeasures = query.measures.filter(
      (m) => !["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
    )
    const spanPage = spanMeasures.length
      ? await executeLogsSql(
          { ...query, measures: spanMeasures, order: [], offset: 0 },
          context
        )
      : undefined
    const row = {
      "logs.startedAt": null,
      ...spanPage?.rows[0],
      ...Object.fromEntries(
        query.measures
          .filter((m) =>
            ["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
          )
          .map((m) => [
            m,
            facts[
              m === "logs.meanLatencyMs" ? "meanDurationMs" : "p95DurationMs"
            ],
          ])
      ),
    }
    return {
      rows: query.offset ? [] : [row],
      paged: true as const,
      ...(query.total ? { total: 1 } : {}),
    }
  }
  const duration = sql`${traces.durationMs}`
  const llm = (value: SQL) =>
    sql`case when ${spans.kind} = 'llm' then ${value} end`
  const needsParent =
    query.dimensions.some((d) => !spanFilterMembers.has(d)) ||
    (() => {
      const visit = (filters: typeof query.filters): boolean =>
        filters.some((f) =>
          "member" in f
            ? !spanFilterMembers.has(f.member)
            : visit("and" in f ? f.and : f.or)
        )
      return visit(query.filters)
    })()
  const dimensionColumns = query.dimensions.length
    ? sql`, ${sql.join(
        query.dimensions.map(
          (d) =>
            sql`${fields[d as keyof typeof fields].value} as ${sql.identifier(d)}`
        ),
        sql`, `
      )}`
    : sql``
  const spanFacts = sql`select ${groupDay(sql`${spans.startedAtMs}`)} as bucket ${dimensionColumns},
    case when ${spans.status} = 'errored' then 1 else 0 end as "erroredCount",
    case when ${spans.status} in ('completed', 'errored') then 1 else 0 end as "terminalCount",
    1 as "spanCount", case when ${spans.kind} = 'llm' then 1 else 0 end as "llmCount",
    case when ${spans.kind} = 'llm' and ${cost.total} is not null then 1 else 0 end as "pricedLlmCount",
    case when ${spans.kind} = 'llm' and ${cost.total} is null then 1 else 0 end as "unpricedLlmCount",
    case when ${spans.kind} = 'tool' then 1 else 0 end as "toolCount",
    case when ${spans.kind} not in ('llm', 'tool') then 1 else 0 end as "otherCount",
    ${llm(total)} as "tokenCount", ${llm(sql`greatest(0, ${input} - coalesce(${cached}, 0) - coalesce(${written}, 0))`)} as "inputTokens",
    ${llm(output)} as "outputTokens", ${llm(sql`case when ${cached} is not null or ${written} is not null then coalesce(${cached}, 0) + coalesce(${written}, 0) end`)} as "cacheTokens",
    ${llm(cost.total)} as "costUsd", ${llm(cost.input)} as "inputCostUsd", ${llm(cost.output)} as "outputCostUsd",
    ${llm(sql`case when ${cost.cacheRead} is not null or ${cost.cacheWrite} is not null then coalesce(${cost.cacheRead}, 0) + coalesce(${cost.cacheWrite}, 0) end`)} as "cacheCostUsd",
    null as duration, ${llm(ttft)} as ttft
    from ${spans} ${needsParent ? sql`inner join ${traces} on ${traces.id} = ${spans.traceId} and ${traces.projectId} = ${spans.projectId}` : sql``}
    ${attribution.join}
    where ${spans.projectId} = ${context.snapshot.projectId} and ${inWindow(sql`${spans.startedAtMs}`)} and ${predicate}
      ${onlyLlmFacts ? sql`and ${spans.kind} = 'llm'` : sql``}`
  const traceFacts = sql`select ${groupDay(sql`${traces.startedAtMs}`)} as bucket ${dimensionColumns},
    0 as "erroredCount", 0 as "terminalCount",
    0 as "spanCount", 0 as "llmCount", 0 as "pricedLlmCount", 0 as "unpricedLlmCount", 0 as "toolCount", 0 as "otherCount",
    null::double precision as "tokenCount", null::double precision as "inputTokens", null::double precision as "outputTokens", null::double precision as "cacheTokens",
    null::double precision as "costUsd", null::double precision as "inputCostUsd", null::double precision as "outputCostUsd", null::double precision as "cacheCostUsd",
    case when ${traces.status} in ('completed', 'errored', 'cancelled') and ${duration} >= 0 then ${duration} end as duration, null::double precision as ttft
    from ${traces} where ${traces.projectId} = ${context.snapshot.projectId} and ${inWindow(sql`${traces.startedAtMs}`)} and ${latencyRequested ? semanticSqlFilters(query.filters, { ...traceSqlFields("logs"), "logs.trace": fields["logs.trace"], "logs.traceName": fields["logs.traceName"] }) : sql`true`}`
  const spanRequested = query.measures.some(
    (m) => !["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
  )
  const facts =
    latencyRequested && spanRequested
      ? sql`${spanFacts} union all ${traceFacts}`
      : latencyRequested
        ? traceFacts
        : spanFacts
  const aggregate = (member: string) => {
    const key = member.slice(5)
    if (key === "costCoverage")
      return sql`sum("pricedLlmCount")::double precision / nullif(sum("llmCount"), 0)`
    if (key === "meanLlmCostUsd")
      return sql`sum("costUsd") / nullif(sum("pricedLlmCount"), 0)`
    if (key === "errorRate")
      return sql`sum("erroredCount")::double precision / nullif(sum("terminalCount"), 0)`
    if (key === "meanLatencyMs") return sql`avg(duration)`
    if (key === "meanTtftMs") return sql`avg(ttft)`
    if (key === "p95LatencyMs" || key === "p95TtftMs") {
      return sql`percentile_disc(0.95) within group(order by ${key === "p95LatencyMs" ? sql`duration` : sql`ttft`})`
    }
    // Members were validated by the semantic catalog before execution.
    return sql`sum(${sql.identifier(key)})`
  }
  const selected = sql.join(
    query.measures.map((m) => sql`${aggregate(m)} as ${sql.identifier(m)}`),
    sql`, `
  )
  const extraGroup = query.dimensions.length
    ? sql`, ${sql.join(
        query.dimensions.map((d) => sql`${sql.identifier(d)}`),
        sql`, `
      )}`
    : sql``
  const grouped = sql`with facts as (${facts}) select bucket ${extraGroup}, ${selected} from facts f group by bucket ${extraGroup}`
  const days = window.hasDayGrain ? buckets.map((b) => b.day) : ["all"]
  const zeroCounts = new Set([
    "logs.spanCount",
    "logs.llmCount",
    "logs.pricedLlmCount",
    "logs.unpricedLlmCount",
    "logs.toolCount",
    "logs.otherCount",
    "logs.erroredCount",
  ])
  const relation = query.dimensions.length
    ? sql`with metrics as (${grouped}) select ${window.hasDayGrain ? sql`bucket` : sql`null::text`} as "logs.startedAt" ${extraGroup}, ${sql.join(
        query.measures.map((m) => sql`${sql.identifier(m)}`),
        sql`, `
      )} from metrics`
    : sql`with metrics as (${grouped}), days(bucket) as (values ${sql.join(
        days.map((day) => sql`(${day}::text)`),
        sql`, `
      )})
      select ${window.hasDayGrain ? sql`days.bucket` : sql`null::text`} as "logs.startedAt",
      ${sql.join(
        query.measures.map(
          (m) =>
            sql`${zeroCounts.has(m) ? sql`coalesce(metrics.${sql.identifier(m)}, 0)` : sql`metrics.${sql.identifier(m)}`} as ${sql.identifier(m)}`
        ),
        sql`, `
      )}
      from days left join metrics on metrics.bucket = days.bucket`
  return executeSqlPage(relation, query, context)
}

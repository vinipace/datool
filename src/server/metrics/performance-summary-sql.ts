import { sql, type SQL } from "drizzle-orm"
import type {
  NormalizedSemanticQuery,
  SemanticFilter,
} from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "../semantic/sql-filters"
import { aggregateSql, sqlDay } from "./aggregate-sql"
import { metricWindow } from "./common"
import { calendarBuckets } from "./logs-sql"

/** Full hours use summaries; the two partial edge hours use exact raw facts. */
export async function executePerformanceSummary(
  model: "agents" | "workflows",
  kind: "agent" | "workflow",
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
) {
  const allowed = new Set([
    "count",
    "versionCount",
    "completedCount",
    "erroredCount",
    "runningCount",
    "cancelledCount",
    "errorRate",
    "meanDurationMs",
    "durationSampleCount",
  ])
  const keys: Record<string, string> = {
    name: "group_name",
    version: "group_version",
    source: "source",
    status: "status",
  }
  const supportedFilters = (filters: readonly SemanticFilter[]): boolean =>
    filters.every((f) =>
      "member" in f
        ? Boolean(keys[f.member.split(".")[1]])
        : supportedFilters("and" in f ? f.and : f.or)
    )
  if (
    query.measures.some((m) => !allowed.has(m.split(".")[1])) ||
    query.dimensions.some((d) => !keys[d.split(".")[1]]) ||
    !supportedFilters(query.filters)
  )
    return undefined
  const time = `${model}.startedAt`,
    window = metricWindow(query, time)
  const innerFrom = Math.ceil(window.fromMs / 3600000) * 3600000
  const innerTo = Math.floor(window.toMs / 3600000) * 3600000
  if (
    innerFrom >= innerTo ||
    (window.hasDayGrain &&
      calendarBuckets(window)
        .flatMap((b) => [b.from, b.to])
        .some((t) => t > window.fromMs && t < window.toMs && t % 3600000))
  )
    return undefined
  const fields: Record<string, SqlFilterField> = Object.fromEntries(
    Object.entries(keys).map(([key, column]) => [
      `${model}.${key}`,
      {
        value: sql`${sql.identifier(column)}`,
        type: "string",
        caseSensitive: true,
      },
    ])
  )
  const predicate = semanticSqlFilters(query.filters, fields)
  const summary = sql`select row_count,duration_count,duration_sum,status,group_name,group_version,source,bucket_ms
    from invocation_hourly_stats where project_id=${context.snapshot.projectId} and kind=${kind}
    and row_count>0 and bucket_ms>=${innerFrom} and bucket_ms<${innerTo}`
  const edge = sql`started_at_ms>=${window.fromMs} and started_at_ms<${window.toMs} and (started_at_ms<${innerFrom} or started_at_ms>=${innerTo})`
  const rawColumns = sql`1 as row_count,case when status in ('completed','errored') and duration_ms is not null then 1 else 0 end as duration_count,
    case when status in ('completed','errored') then coalesce(duration_ms,0)::numeric else 0 end as duration_sum,status,group_name,group_version`
  const edges =
    innerFrom !== window.fromMs || innerTo !== window.toMs
      ? sql`
    union all select ${rawColumns},'trace' as source,started_at_ms as bucket_ms from traces where project_id=${context.snapshot.projectId} and group_type=${kind} and group_name is not null and ${edge}
    union all select ${rawColumns},'span' as source,started_at_ms as bucket_ms from spans where project_id=${context.snapshot.projectId} and group_type=${kind} and group_name is not null and ${edge}`
      : sql``
  const facts = sql`select row_count, duration_count, duration_sum, status, group_version as version_value, ${sqlDay(query, time, sql`bucket_ms`)} as ${sql.identifier(time)}
    ${
      query.dimensions.length
        ? sql`, ${sql.join(
            query.dimensions.map(
              (d) =>
                sql`${sql.identifier(keys[d.split(".")[1]])} as ${sql.identifier(d)}`
            ),
            sql`, `
          )}`
        : sql``
    }
    from (${summary} ${edges}) observations where ${predicate}`
  const sum = (value: SQL) => sql`coalesce(sum(${value}),0)`
  const terminal = sql`status in ('completed','errored')`
  const page = await aggregateSql(
    query,
    context,
    facts,
    time,
    {
      count: sum(sql`row_count`),
      versionCount: sql`count(distinct version_value)`,
      ...Object.fromEntries(
        ["completed", "errored", "running", "cancelled"].map((status) => [
          `${status}Count`,
          sql`coalesce(sum(row_count) filter(where status=${status}),0)`,
        ])
      ),
      durationSampleCount: sum(sql`duration_count`),
      meanDurationMs: sql`sum(duration_sum)::double precision/nullif(sum(duration_count),0)`,
      errorRate: sql`coalesce(sum(row_count) filter(where status='errored'),0)::double precision/nullif(sum(row_count) filter(where ${terminal}),0)`,
    },
    [],
    {
      duration: {
        predicate: terminal,
        weight: sql`row_count-duration_count`,
        message:
          "completed or errored invocations had no valid latency sample.",
      },
      status: {
        predicate: sql`status not in ('completed','errored','running','cancelled')`,
        weight: sql`row_count`,
        message: "invocations had unrecognized statuses.",
      },
    }
  )
  const invalid = await context.snapshot
    .execute(sql`select count(*) as count from (
    select group_name,group_version,'trace' as source,status from traces where project_id=${context.snapshot.projectId} and group_type=${kind} and group_name is not null and started_at_ms is null
    union all select group_name,group_version,'span' as source,status from spans where project_id=${context.snapshot.projectId} and group_type=${kind} and group_name is not null and started_at_ms is null
  ) invalid where ${predicate}`)
  const count = Number(invalid.rows[0].count)
  return {
    ...page,
    warnings: [
      ...page.warnings,
      ...(count
        ? [
            `${count} persisted invocation row(s) had an invalid startedAt and were excluded.`,
          ]
        : []),
    ],
  }
}

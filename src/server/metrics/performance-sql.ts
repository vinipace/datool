import { executePerformanceSummary } from "./performance-summary-sql"
import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, lifecycleMeasures, sqlDay } from "./aggregate-sql"
import { metricWindow } from "./common"
import { invocationSqlField } from "./group-filter"
import { fullTextSqlField } from "../semantic/full-text-filter"

export async function executePerformanceSql(
  model: "agents" | "workflows",
  kind: "agent" | "workflow",
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
) {
  const summary = await executePerformanceSummary(model, kind, query, context)
  if (summary) return summary
  const time = `${model}.startedAt`,
    window = metricWindow(query, time),
    project = context.snapshot.projectId
  const columns: Record<string, SQL> = {
    name: sql`group_name`,
    version: sql`group_version`,
    source: sql`source`,
    status: sql`status`,
    traceId: sql`trace_id`,
    invocationId: sql`id`,
  }
  const fields: Record<string, SqlFilterField> = Object.fromEntries(
    Object.entries(columns).map(([k, v]) => [
      `${model}.${k}`,
      { value: v, type: "string", caseSensitive: true },
    ])
  )
  fields[`${model}.invocationGroup`] = invocationSqlField(
    sql`${project}`,
    sql`invocations.trace_id`,
    kind
  )
  fields[`${model}.fullText`] = fullTextSqlField([
    fields[`${model}.name`],
    fields[`${model}.version`],
  ])
  const roots = sql`select * from (
    select id, id as trace_id, null::text as parent_id, group_name, group_version, group_type as kind, 'trace'::text as source, status, started_at_ms, ended_at_ms, reported_cost_usd, cost_present
    from traces where project_id = ${project} and group_type = ${kind} and group_name is not null and started_at_ms >= ${window.fromMs} and started_at_ms < ${window.toMs}
    union all
    select id, trace_id, parent_id, group_name, group_version, kind, 'span'::text as source, status, started_at_ms, ended_at_ms, reported_cost_usd, cost_present
    from spans where project_id = ${project} and group_type = ${kind} and group_name is not null and started_at_ms >= ${window.fromMs} and started_at_ms < ${window.toMs}
  ) invocations where ${semanticSqlFilters(query.filters, fields)}`
  const costRequested = query.measures.some((m) => /(?:Cost|cost)/.test(m))
  const cost = sql`reported_cost_usd`
  const costing = costRequested
    ? sql`, missing_roots as materialized (select * from roots where reported_cost_usd is null), nodes as materialized (
    select id, trace_id, parent_id, kind, ${cost} as cost, cost_present as reported
    from spans where project_id = ${project} and trace_id in (select trace_id from missing_roots)
  ), walk as (
    select source || ':' || id as root, trace_id, case when source = 'trace' then null::text else id end as node,
      kind, ${cost} as cost, cost_present as reported, case when source = 'trace' then array[]::text[] else array[id]::text[] end as path, false as cycle
    from missing_roots
    union all
    select w.root, n.trace_id, n.id, n.kind, n.cost, n.reported, w.path || n.id, n.id = any(w.path)
    from walk w join nodes n on n.trace_id = w.trace_id and n.parent_id is not distinct from w.node
    where w.cost is null and not w.cycle
  ), costs as (
    select root, sum(cost) as cost, bool_and(not cycle and (cost is not null or (not reported and kind <> 'llm'))) as complete
    from walk group by root
  )`
    : sql``
  const facts = sql`with recursive roots as not materialized (${roots}) ${costing}
    select r.status as status, r.group_version as version_value,
    case when r.status in ('completed','errored') and r.ended_at_ms >= r.started_at_ms then r.ended_at_ms-r.started_at_ms end as duration,
    ${costRequested ? sql`coalesce(r.reported_cost_usd, c.cost)` : sql`null::double precision`} as cost,
    ${costRequested ? sql`case when r.reported_cost_usd is not null then true else c.complete end` : sql`false`} as complete,
    ${sqlDay(query, time, sql`r.started_at_ms`)} as ${sql.identifier(time)}
    ${
      query.dimensions.length
        ? sql`, ${sql.join(
            query.dimensions.map(
              (d) =>
                sql`r.${sql.identifier(({ name: "group_name", version: "group_version", traceId: "trace_id", invocationId: "id", source: "source", status: "status" } as Record<string, string>)[d.split(".")[1]])} as ${sql.identifier(d)}`
            ),
            sql`, `
          )}`
        : sql``
    }
    from roots r ${costRequested ? sql`left join costs c on c.root = r.source || ':' || r.id` : sql``}`
  const page = await aggregateSql(
    query,
    context,
    facts,
    time,
    {
      count: sql`count(*)`,
      versionCount: sql`count(distinct version_value)`,
      ...lifecycleMeasures(["completed", "errored", "running", "cancelled"]),
      errorRate: sql`count(*) filter(where status='errored')::double precision/nullif(count(*) filter(where status in ('completed','errored')),0)`,
      meanDurationMs: sql`avg(duration)`,
      p95DurationMs: sql`percentile_disc(0.95) within group(order by duration)`,
      durationSampleCount: sql`count(duration)`,
      reportedCostUsd: sql`sum(cost)`,
      costSampleCount: sql`count(cost)`,
      completeCostCount: sql`count(*) filter(where cost is not null and complete)`,
    },
    [],
    {
      duration: {
        predicate: sql`status in ('completed','errored') and duration is null`,
        message:
          "completed or errored invocations had no valid latency sample.",
      },
      ...(costRequested
        ? {
            cost: {
              predicate: sql`cost is null or not complete`,
              message: "invocations had missing or partial cost reports.",
            },
          }
        : {}),
      status: {
        predicate: sql`status not in ('completed','errored','running','cancelled')`,
        message: "invocations had unrecognized statuses.",
      },
    }
  )
  const warnings = [...page.warnings]
  const invalidTime = await context.snapshot
    .execute(sql`select count(*) as count from (
    select id,id as trace_id,group_name,group_version,'trace' as source,status from traces where project_id=${project} and group_type=${kind} and group_name is not null and started_at_ms is null
    union all select id,trace_id,group_name,group_version,'span' as source,status from spans where project_id=${project} and group_type=${kind} and group_name is not null and started_at_ms is null
  ) invocations where ${semanticSqlFilters(query.filters, fields)}`)
  const invalidCount = Number(invalidTime.rows[0].count)
  if (invalidCount)
    warnings.push(
      `${invalidCount} persisted invocation row(s) had an invalid startedAt and were excluded.`
    )
  return { ...page, warnings }
}

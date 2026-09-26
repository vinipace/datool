import { relatedEvaluationFields } from "./related-evaluation-filters"
import {
  scalarQuery,
  traceScalarFacts,
  traceScalarWarnings,
} from "./trace-scalar-facts"
import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import { traces, spans } from "@/src/server/tracer/schema"
import { semanticSqlFilters } from "@/src/server/semantic/sql-filters"
import { traceSqlFields } from "./trace-fields"
import { aggregateSql, lifecycleMeasures, sqlDay } from "./aggregate-sql"
import { diagnosticWarnings } from "./quality-sql"
import { llmFactColumns, recordedModelSql } from "./llm-facts"
import { metricWindow } from "./common"

export async function executeTracesSql(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
) {
  const window = metricWindow(query, "traces.startedAt")
  const cost = sql`${traces.costUsd}`
  const rollupMeasures = new Set([
    "uniqueUserCount",
    "uniqueSessionCount",
    "llmCount",
    "pricedLlmCount",
    "unpricedLlmCount",
    "costCoverage",
    "meanLlmCostUsd",
    "costUsd",
    "inputCostUsd",
    "outputCostUsd",
    "cacheCostUsd",
    "tokenCount",
    "inputTokens",
    "outputTokens",
    "cacheTokens",
    "pricedTraceCount",
  ])
  const relatedNames = [
    "agentName",
    "agentVersion",
    "workflowName",
    "workflowVersion",
    "model",
  ]
  const members = new Set(query.dimensions)
  const visit = (filters: typeof query.filters) => {
    for (const f of filters) {
      if ("member" in f) members.add(f.member)
      else visit("and" in f ? f.and : f.or)
    }
  }
  visit(query.filters)
  const agent = relatedNames.slice(0, 2).some((k) => members.has(`traces.${k}`))
  const workflow = relatedNames
    .slice(2, 4)
    .some((k) => members.has(`traces.${k}`))
  const needsRollup =
    query.measures.some((m) => rollupMeasures.has(m.split(".")[1])) ||
    members.has("traces.model")
  const user = sql`coalesce(nullif(${traces.attributesJson} ->> 'user.id', ''), nullif(${traces.attributesJson} ->> 'enduser.id', ''), nullif(${traces.attributesJson} ->> 'userId', ''))`
  const joins = sql`
    ${agent ? sql`left join trace_group_memberships agent on agent.project_id=${traces.projectId} and agent.trace_id=${traces.id} and agent.group_type='agent'` : sql``}
    ${workflow ? sql`left join trace_group_memberships workflow on workflow.project_id=${traces.projectId} and workflow.trace_id=${traces.id} and workflow.group_type='workflow'` : sql``}
    ${
      needsRollup
        ? sql`left join lateral (select
      ${sql.join(
        Object.entries(llmFactColumns).map(
          ([key, value]) => sql`sum(${value}) as ${sql.identifier(key)}`
        ),
        sql`, `
      )},
      count(*) as llms, count(${spans.costUsd}) as priced,
      case count(distinct ${recordedModelSql}) when 0 then null when 1 then min(${recordedModelSql}) else 'Multiple models' end as model
      from ${spans} where ${spans.projectId}=${traces.projectId} and ${spans.traceId}=${traces.id} and ${spans.kind}='llm') usage on true`
        : sql``
    }`
  const fields = {
    ...relatedEvaluationFields("traces"),
    "traces.agentName": {
      value: sql`agent.group_name`,
      type: "string" as const,
    },
    "traces.agentVersion": {
      value: sql`agent.group_version`,
      type: "string" as const,
    },
    "traces.workflowName": {
      value: sql`workflow.group_name`,
      type: "string" as const,
    },
    "traces.workflowVersion": {
      value: sql`workflow.group_version`,
      type: "string" as const,
    },
    "traces.model": { value: sql`usage.model`, type: "string" as const },
    ...traceSqlFields("traces"),
    "traces.traceName": {
      value: sql`${traces.name}`,
      type: "string" as const,
      caseSensitive: true,
    },
    "traces.userId": {
      value: sql`coalesce(nullif(${traces.attributesJson} ->> 'user.id', ''), nullif(${traces.attributesJson} ->> 'enduser.id', ''), nullif(${traces.attributesJson} ->> 'userId', ''))`,
      type: "string" as const,
      caseSensitive: true,
    },
    "traces.status": { value: sql`${traces.status}`, type: "string" as const },
    "traces.operation": {
      value: sql`${traces.operation}`,
      type: "string" as const,
    },
    "traces.sessionId": {
      value: sql`${traces.sessionId}`,
      type: "string" as const,
    },
    "traces.trace": {
      value: sql`${traces.name} || ' · ' || ${traces.id}`,
      type: "string" as const,
    },
    "traces.hasReportedCost": {
      value: sql`case when ${cost} is not null then 'yes' else 'no' end`,
      type: "string" as const,
    },
  }
  if (
    scalarQuery(query) &&
    !query.having?.length &&
    !needsRollup &&
    !agent &&
    !workflow
  ) {
    const facts = await traceScalarFacts(query, context, fields)
    return {
      rows: query.offset
        ? []
        : [
            {
              "traces.startedAt": null,
              ...Object.fromEntries(
                query.measures.map((member) => [
                  member,
                  facts[member.split(".")[1]],
                ])
              ),
            },
          ],
      paged: true as const,
      ...(query.total ? { total: 1 } : {}),
      warnings: traceScalarWarnings(
        facts,
        query.measures.includes("traces.reportedCostUsd")
      ),
    }
  }
  const duration = sql`${traces.durationMs}`
  const facts = sql`select distinct ${traces.id} as id, ${user} as user_id, ${traces.sessionId} as session_id, ${traces.status} as status, ${duration} as duration, ${cost} as cost, ${traces.costStatus} as cost_status,
    ${sqlDay(query, "traces.startedAt", sql`${traces.startedAtMs}`)} as "traces.startedAt"
    ${
      needsRollup
        ? sql`, usage.llms, usage.priced, ${sql.join(
            Object.keys(llmFactColumns).map(
              (k) => sql`usage.${sql.identifier(k)}`
            ),
            sql`, `
          )}`
        : sql``
    }
    ${
      query.dimensions.length
        ? sql`, ${sql.join(
            query.dimensions.map(
              (d) =>
                sql`${fields[d as keyof typeof fields].value} as ${sql.identifier(d)}`
            ),
            sql`, `
          )}`
        : sql``
    }
    from ${traces} ${joins} where ${traces.projectId} = ${context.snapshot.projectId}
    and ${traces.startedAtMs} >= ${window.fromMs} and ${traces.startedAtMs} < ${window.toMs}
    and ${semanticSqlFilters(query.filters, fields)}`
  const page = await aggregateSql(
    query,
    context,
    facts,
    "traces.startedAt",
    {
      count: sql`count(*)`,
      uniqueUserCount: sql`count(distinct user_id)`,
      uniqueSessionCount: sql`count(distinct session_id)`,
      ...(Object.fromEntries(
        Object.keys(llmFactColumns).map((k) => [
          k,
          sql`sum(${sql.identifier(k)})`,
        ])
      ) as Record<string, SQL>),
      llmCount: sql`coalesce(sum(llms),0)`,
      pricedLlmCount: sql`coalesce(sum(priced),0)`,
      unpricedLlmCount: sql`coalesce(sum(llms-priced),0)`,
      costCoverage: sql`sum(priced)::double precision/nullif(sum(llms),0)`,
      meanLlmCostUsd: sql`sum("costUsd")/nullif(count(*) filter(where priced>0),0)`,
      pricedTraceCount: sql`count(*) filter(where priced>0)`,
      errorRate: sql`count(*) filter(where status = 'errored')::double precision / nullif(count(*) filter(where status in ('completed', 'errored')), 0)`,
      ...lifecycleMeasures(["completed", "errored", "cancelled", "running"]),
      durationSampleCount: sql`count(duration)`,
      meanDurationMs: sql`avg(duration)`,
      p95DurationMs: sql`percentile_disc(0.95) within group (order by duration)`,
      reportedCostUsd: sql`sum(cost)`,
    },
    [],
    {
      duration: {
        predicate: sql`status in ('completed','errored','cancelled') and duration is null`,
        message:
          "terminal trace row(s) had no valid persisted duration sample.",
      },
      status: {
        predicate: sql`status not in ('completed','errored','cancelled','running')`,
        message:
          "trace row(s) used an unrecognized persisted lifecycle status.",
      },
      ...(query.measures.includes("traces.reportedCostUsd")
        ? {
            estimated: {
              predicate: sql`cost_status = 'estimated'`,
              message: "trace cost(s) are estimates, not invoiced amounts.",
            },
            cost: {
              predicate: sql`cost is null`,
              message:
                "trace(s) in this time window have no complete cost report; their costs are unknown.",
            },
          }
        : {}),
    }
  )
  const invalid = await diagnosticWarnings(
    context,
    sql`select ${traces.id} from ${traces} ${joins} where ${traces.projectId}=${context.snapshot.projectId} and ${traces.startedAtMs} is null and ${semanticSqlFilters(query.filters, fields)}`,
    {
      invalid: {
        predicate: sql`true`,
        message:
          "persisted trace row(s) had an invalid startedAt and were excluded.",
      },
    }
  )
  return { ...page, warnings: [...page.warnings, ...invalid] }
}

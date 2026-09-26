import { sql } from "drizzle-orm"
import type {
  NormalizedSemanticQuery,
  SemanticFilter,
} from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import {
  evalRuns,
  evalResults,
  scores,
  evaluatorVersions,
  evaluators,
  datasetItems,
} from "@/src/server/tracer/schema"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, countWhere, sqlDay } from "./aggregate-sql"
import { diagnosticWarnings } from "./quality-sql"
import { metricWindow } from "./common"

const groupMembers = new Set([
  "scores.groupType",
  "scores.groupName",
  "scores.groupVersion",
])
function filtersGroups(filters: SemanticFilter[]): boolean {
  return filters.some((filter) =>
    "member" in filter
      ? groupMembers.has(filter.member)
      : filtersGroups("and" in filter ? filter.and : filter.or)
  )
}

export async function executeScoresSql(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
) {
  const window = metricWindow(query, "scores.completedAt"),
    project = context.snapshot.projectId
  const columns = {
    status: evalResults.status,
    evalRunId: evalResults.runId,
    evalRunName: evalRuns.name,
    evaluatorId: evalResults.evaluatorId,
    evaluatorVersionId: evalResults.evaluatorVersionId,
    evaluatorVersion: evaluatorVersions.version,
    evaluatorName: evaluators.name,
    datasetId: datasetItems.datasetId,
    traceId: evalResults.traceId,
    groupType: sql`membership.group_type`,
    groupName: sql`membership.group_name`,
    groupVersion: sql`membership.group_version`,
  }
  const fields: Record<string, SqlFilterField> = Object.fromEntries(
    Object.entries(columns).map(([key, value]) => [
      `scores.${key}`,
      {
        value: sql`${value}`,
        type: key === "evaluatorVersion" ? "number" : "string",
        caseSensitive: true,
      },
    ])
  )
  const groups =
    query.dimensions.some((member) => groupMembers.has(member)) ||
    filtersGroups(query.filters)
  // DISTINCT includes execution identity: repeated memberships and filter-only
  // matches collapse without merging separate executions with identical scores.
  const facts = sql`select ${groups ? sql`distinct` : sql``} ${evalResults.id} as execution_id, ${scores.status} as score_status, ${evalResults.traceId} as trace_id, ${evalResults.status} as status, ${evalResults.passed} as passed,
    case when ${scores.status} = 'ok' and ${scores.value} >= 0 and ${scores.value} <= 1 then ${scores.value} end as score,
    ${sqlDay(query, "scores.completedAt", sql`${evalResults.eventAtMs}`)} as "scores.completedAt"
    ${
      query.dimensions.length
        ? sql`, ${sql.join(
            query.dimensions.map(
              (d) => sql`${fields[d].value} as ${sql.identifier(d)}`
            ),
            sql`, `
          )}`
        : sql``
    }
    from ${evalResults}
    left join ${scores} on ${scores.projectId} = ${project} and ${scores.evalResultId} = ${evalResults.id} and ${scores.name} = 'score'
    left join ${evaluatorVersions} on ${evaluatorVersions.projectId} = ${project} and ${evaluatorVersions.id} = ${evalResults.evaluatorVersionId}
    left join ${evaluators} on ${evaluators.projectId} = ${project} and ${evaluators.id} = ${evalResults.evaluatorId}
    left join ${datasetItems} on ${datasetItems.projectId} = ${project} and ${datasetItems.id} = ${evalResults.datasetItemId}
    left join ${evalRuns} on ${evalRuns.projectId} = ${project} and ${evalRuns.id} = ${evalResults.runId}
    ${groups ? sql`left join trace_group_memberships membership on membership.project_id = ${project} and membership.trace_id = ${evalResults.traceId}` : sql``}
    where ${evalResults.projectId} = ${project} and ${evalResults.eventAtMs} >= ${window.fromMs} and ${evalResults.eventAtMs} < ${window.toMs}
    and ${semanticSqlFilters(query.filters, fields)}`
  const page = await aggregateSql(
    query,
    context,
    facts,
    "scores.completedAt",
    {
      executionCount: sql`count(*)`,
      scoredCount: sql`count(score)`,
      meanScore: sql`avg(score)`,
      explicitPassCount: countWhere(sql`passed is true`),
      explicitFailCount: countWhere(sql`passed is false`),
      explicitPassRate: sql`count(*) filter(where passed is true)::double precision / nullif(count(passed),0)`,
      errorCount: countWhere(sql`status = 'error'`),
      failedCheckCount: countWhere(sql`status = 'failed'`),
      uniqueTraceCount: sql`count(distinct trace_id)`,
    },
    ["scores.evaluatorVersion"]
  )
  const diagnostics = groups
    ? sql`select distinct execution_id, status, score_status, score from (${facts}) attributed`
    : facts
  const warnings = await diagnosticWarnings(context, diagnostics, {
    errors: {
      predicate: sql`status = 'error'`,
      message: "evaluation execution(s) had technical errors.",
    },
    invalid: {
      predicate: sql`score_status = 'ok' and score is null`,
      message:
        "score row(s) declared status ok without a finite value from 0 through 1 and were excluded from scored measures.",
    },
    status: {
      predicate: sql`status not in ('completed','error','failed','passed')`,
      message: "evaluation execution(s) had unrecognized statuses.",
    },
  })
  const invalidTime = await context.snapshot.execute(
    sql`select count(*) as count from ${evalResults} where ${evalResults.projectId} = ${project} and ${evalResults.eventAtMs} is null`
  )
  if (Number(invalidTime.rows[0].count))
    warnings.push(
      `${invalidTime.rows[0].count} persisted evaluator-result row(s) had an invalid event time and were excluded.`
    )
  return { ...page, warnings }
}

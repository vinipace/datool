import { sql } from "drizzle-orm"
import type {
  EvalRunSummary,
  EvalRunGroupSummary,
} from "@/src/lib/tracer/contracts"
import {
  safeJson,
  semanticSqlFilters,
  type SqlFilterField,
} from "../semantic/sql-filters"
import { scopedTracerTransaction, type TracerDatabase } from "./db"
import { collectionSqlFilter, collectionSqlPage } from "./collection-sql"

export async function listEvalSummaries(
  database: TracerDatabase,
  project: string,
  options: {
    includeTotal?: boolean
    filter?: string | null
    cursor?: string | null
    limit?: number
  }
) {
  const doc = safeJson(sql`r.metadata_json`)
  const name = sql`case when jsonb_typeof(${doc}->'name')='string' then ${doc}->>'name' else coalesce(${doc}->>'scorerName',e.name,'Unknown evaluator') end`
  const value = sql`case when jsonb_typeof(${doc}->'booleanScore')='boolean' then ${doc}->'booleanScore' else coalesce(to_jsonb(r.score),to_jsonb(r.passed)) end`
  const { relation, fields } = evalSummarySource(project)
  const filter = collectionSqlFilter("evals", options.filter, fields)
  // The outer transaction keeps page summaries and named metric enrichment together.
  return database.transaction(
    async (tx) => {
      const page = await collectionSqlPage<
        EvalRunSummary & { metadata: string }
      >(
        scopedTracerTransaction(database, tx),
        sql`select * from (${relation}) summaries where ${filter}`,
        options,
        "createdAt"
      )
      const ids = page.items.map((row) => row.id)
      if (!ids.length) return page
      const metrics = await tx.execute(sql`with result_values as (
      select r.run_id, ${name} as name, ${value} as value, ${doc}->'metrics' as metrics
      from eval_results r left join evaluators e on e.project_id=${project} and e.id=r.evaluator_id
      where r.project_id=${project} and r.run_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})
    ), named_values as (
      select run_id,name,value from result_values
      union all select run_id, name || ' · ' || m.key,m.value
      from result_values cross join lateral jsonb_each(case when jsonb_typeof(metrics)='object' then metrics else '{}'::jsonb end) m
      where jsonb_typeof(m.value) in ('number','boolean')
    ) select run_id,name,case
      when count(value) filter(where value <> 'null'::jsonb)=0 then null
      when bool_and(jsonb_typeof(value)='number') filter(where value <> 'null'::jsonb) then to_jsonb(avg(case when jsonb_typeof(value)='number' then (value::text)::double precision end))
      when bool_and(value='true'::jsonb) filter(where value <> 'null'::jsonb) then 'true'::jsonb
      when bool_and(value='false'::jsonb) filter(where value <> 'null'::jsonb) then 'false'::jsonb else null end as value
      from named_values group by run_id,name`)
      const byRun = new Map<string, NonNullable<EvalRunSummary["scores"]>>()
      for (const row of metrics.rows as {
        run_id: string
        name: string
        value: number | boolean | null
      }[]) {
        const values = byRun.get(row.run_id) ?? []
        values.push({ name: row.name, value: row.value })
        byRun.set(row.run_id, values)
      }
      return {
        ...page,
        items: page.items.map((row) => ({
          ...row,
          metadata: JSON.parse(row.metadata),
          scores: byRun.get(row.id) ?? [],
        })),
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  )
}

function evalSummarySource(project: string) {
  const relation = sql`select id, name, metadata_json as metadata, dataset_id as "datasetId", status, created_at as "createdAt",completed_at as "completedAt",groups_resolved_at as "groupsResolvedAt",
    coalesce((select jsonb_agg(jsonb_build_object('type',g.group_type,'name',g.group_name,'version',g.group_version) order by g.group_type,g.group_name,g.group_version) from eval_run_groups g where g.project_id=${project} and g.run_id=eval_runs.id),'[]'::jsonb) as groups,
    (select count(*)::integer from eval_results r where r.project_id=${project} and r.run_id=eval_runs.id) as "resultCount",
    (select avg(r.score) from eval_results r where r.project_id=${project} and r.run_id=eval_runs.id) as score,
    (select count(*)::integer from eval_run_targets t where t.project_id=${project} and t.run_id=eval_runs.id) as "targetCount",
    (select count(distinct t.trace_id)::integer from eval_run_targets t where t.project_id=${project} and t.run_id=eval_runs.id) as "traceCount",
    coalesce((select jsonb_agg(e.evaluator_id order by e.id) from eval_run_evaluators e where e.project_id=${project} and e.run_id=eval_runs.id),'[]'::jsonb) as "evaluatorIds"
    from eval_runs where project_id=${project}`
  const groupField = (type: "agent" | "workflow"): SqlFilterField => ({
    type: "string",
    value: sql`null::text`,
    predicate: (filter) => {
      const negate = filter.operator === "notEquals"
      const value = filter.values?.[0]
      const exists = sql`exists(select 1 from eval_run_groups g where g.project_id=${project} and g.run_id=summaries.id and g.group_type=${type}
        ${value === null ? sql`` : sql`and ${semanticSqlFilters([{ ...filter, member: "name", operator: negate ? "equals" : filter.operator }], { name: { value: sql`g.group_name`, type: "string", caseSensitive: true } })}`})`
      return (value === null) !== negate ? sql`not ${exists}` : exists
    },
  })
  const fields = {
    id: { value: sql`id`, type: "string" as const },
    name: { value: sql`name`, type: "string" as const },
    datasetId: { value: sql`"datasetId"`, type: "string" as const },
    status: { value: sql`status`, type: "string" as const },
    groupsResolvedAt: { value: sql`"groupsResolvedAt"`, type: "date" as const },
    groups: { value: sql`groups`, type: "json" as const },
    workflow: groupField("workflow"),
    agent: groupField("agent"),
    metadata: { value: sql`metadata`, type: "json" as const },
    score: { value: sql`score`, type: "number" as const },
    resultCount: { value: sql`"resultCount"`, type: "number" as const },
    createdAt: { value: sql`"createdAt"`, type: "date" as const },
    completedAt: { value: sql`"completedAt"`, type: "date" as const },
  }
  return { relation, fields }
}

/** Group the entire filtered collection, then page groups; runs load separately per group. */
export async function listEvalRunGroups(
  database: TracerDatabase,
  project: string,
  options: {
    groupBy: "workflow" | "agent"
    filter?: string | null
    cursor?: string | null
    limit?: number
    includeTotal?: boolean
  }
) {
  const { relation, fields } = evalSummarySource(project)
  const filter = collectionSqlFilter("evals", options.filter, fields)
  const type = options.groupBy
  const grouped = sql`with eligible as not materialized (
    select id,"groupsResolvedAt" from (${relation}) summaries where ${filter}
  ), memberships as (
    select distinct g.run_id,g.group_name from eval_run_groups g join eligible r on r.id=g.run_id
    where g.project_id=${project} and g.group_type=${type}
  ), groups as (
    select group_name as name,'assigned'::text as state,count(*)::integer as "runCount" from memberships group by group_name
    union all
    select null::text as name,case when r."groupsResolvedAt" is null then 'unresolved' else 'unassigned' end as state,count(*)::integer as "runCount"
    from eligible r where not exists(select 1 from eval_run_groups g where g.project_id=${project} and g.run_id=r.id and g.group_type=${type})
    group by (r."groupsResolvedAt" is null)
  ) select jsonb_build_array(${type}::text,state,name)::text as id,${type}::text as type,name,state,"runCount" from groups`
  const page = await collectionSqlPage<Omit<EvalRunGroupSummary, "filter">>(
    database,
    grouped,
    options,
    "id",
    true
  )
  return {
    ...page,
    items: page.items.map((group) => ({
      ...group,
      filter: [
        options.filter,
        group.state === "assigned"
          ? `${type} = ${JSON.stringify(group.name)}`
          : `${type} = null groupsResolvedAt ${group.state === "unresolved" ? "=" : "!="} null`,
      ]
        .filter(Boolean)
        .join(" "),
    })),
  }
}

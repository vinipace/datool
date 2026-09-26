import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import { spans, traces } from "@/src/server/tracer/schema"

export const costAttributionMembers = [
  "logs.functionName",
  "logs.agentName",
  "logs.workflowName",
  "logs.stepName",
  "logs.agentVersion",
  "logs.workflowVersion",
  "logs.executionRole",
] as const

/** One ancestry row per span; group membership itself is never inherited or changed. */
export function costAttributionSql(
  query: NormalizedSemanticQuery,
  model = "logs"
) {
  const members = new Set<string>(query.dimensions)
  const visit = (filters: typeof query.filters) => {
    for (const filter of filters) {
      if ("member" in filter) members.add(filter.member)
      else visit("and" in filter ? filter.and : filter.or)
    }
  }
  visit(query.filters)
  const names = costAttributionMembers.map((member) =>
    member.replace(/^logs[.]/, `${model}.`)
  )
  const requested = names.some((member) => members.has(member))
  const fields = Object.fromEntries(
    names.map((member) => [
      member,
      {
        value: sql`attribution.${sql.identifier(member.split(".")[1])}`,
        type: "string" as const,
        caseSensitive: true,
      },
    ])
  )
  if (!requested) return { fields, join: sql`` }

  const nearest = (predicate: SQL, value: SQL) => sql`(
    select ${value} from ancestry where ${predicate} order by depth limit 1
  )`
  const functionId = sql`coalesce(nullif(attributes_json ->> 'ai.telemetry.functionId', ''), nullif(attributes_json ->> 'ai.functionId', ''))`
  const functionName = nearest(
    sql`${functionId} is not null or (kind = 'function' and name !~ '^ai[.](generateText|streamText|generateObject|streamObject)([.].*)?$') or (group_type = 'agent' and group_name is not null)`,
    sql`coalesce(${functionId}, case when kind = 'function' then name else group_name end)`
  )
  return {
    fields,
    join: sql`left join lateral (
      with recursive ancestry as (
        select ${spans.id} as id, ${spans.parentId} as parent_id, ${spans.name} as name,
          ${spans.kind} as kind, ${spans.groupType} as group_type, ${spans.groupName} as group_name,
          ${spans.groupVersion} as group_version, ${spans.attributesJson} as attributes_json, 0 as depth, array[${spans.id}]::text[] as path
        union all
        select p.id, p.parent_id, p.name, p.kind, p.group_type, p.group_name, p.group_version, p.attributes_json,
          a.depth + 1, a.path || p.id
        from ancestry a join ${spans} p on p.id = a.parent_id
          and p.project_id = ${spans.projectId} and p.trace_id = ${spans.traceId}
        where not p.id = any(a.path)
      )
      select coalesce(${functionName}, (
        select t.group_name from ${traces} t where t.id = ${spans.traceId}
          and t.project_id = ${spans.projectId} and t.group_type = 'agent'
      )) as "functionName",
      coalesce(${nearest(sql`group_type = 'agent' and group_name is not null`, sql`group_name`)}, (
        select t.group_name from ${traces} t where t.id = ${spans.traceId}
          and t.project_id = ${spans.projectId} and t.group_type = 'agent'
      )) as "agentName",
      coalesce(${nearest(sql`group_type = 'workflow' and group_name is not null`, sql`group_name`)}, (
        select t.group_name from ${traces} t where t.id = ${spans.traceId}
          and t.project_id = ${spans.projectId} and t.group_type = 'workflow'
      )) as "workflowName",
      ${nearest(sql`kind = 'task'`, sql`name`)} as "stepName",
      case when ${nearest(sql`group_type = 'agent' and group_name is not null`, sql`group_name`)} is not null then ${nearest(sql`group_type = 'agent' and group_name is not null`, sql`group_version`)} else (select t.group_version from ${traces} t where t.project_id=${spans.projectId} and t.id=${spans.traceId} and t.group_type='agent') end as "agentVersion",
      case when ${nearest(sql`group_type = 'workflow' and group_name is not null`, sql`group_name`)} is not null then ${nearest(sql`group_type = 'workflow' and group_name is not null`, sql`group_version`)} else (select t.group_version from ${traces} t where t.project_id=${spans.projectId} and t.id=${spans.traceId} and t.group_type='workflow') end as "workflowVersion",
      case when exists(select 1 from ancestry where kind='score' or attributes_json ->> 'datool.scorer.execution' = 'true' or attributes_json ->> 'datool.execution.role' = 'scorer') then 'scorer'
        when exists(select 1 from ancestry where attributes_json ->> 'datool.execution.role' = 'workload') then 'workload' end as "executionRole"
    ) attribution on true`,
  }
}

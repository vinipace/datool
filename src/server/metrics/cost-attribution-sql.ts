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
  const requested = names.filter((member) => members.has(member))
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
  if (!requested.length) return { fields, join: sql`` }

  const keys = requested.map((member) => member.split(".")[1])
  const needsFunction = keys.includes("functionName")
  const needsRole = keys.includes("executionRole")
  // Carry only the attribution scalars through recursion, never entire prompt,
  // response or tool payloads. Unrequested metadata is not read or decoded.
  const functionId = (attributes: SQL) =>
    needsFunction
      ? sql`coalesce(nullif(${attributes} ->> 'ai.telemetry.functionId', ''), nullif(${attributes} ->> 'ai.functionId', ''))`
      : sql`null::text`
  const executionRole = (attributes: SQL, kind: SQL) =>
    needsRole
      ? sql`case when ${kind} = 'score' or ${attributes} ->> 'datool.scorer.execution' = 'true' or ${attributes} ->> 'datool.execution.role' = 'scorer' then 'scorer'
          when ${attributes} ->> 'datool.execution.role' = 'workload' then 'workload' end`
      : sql`null::text`
  const functionMatch = (prefix: string) => {
    const column = (name: string) => sql.raw(`${prefix}${name}`)
    return sql`${column("function_id")} is not null or (${column("kind")} = 'function' and ${column("name")} !~ '^ai[.](generateText|streamText|generateObject|streamObject)([.].*)?$') or (${column("group_type")} = 'agent' and ${column("group_name")} is not null)`
  }
  const groupMatch = (type: string, prefix = "") =>
    sql`${sql.raw(`${prefix}group_type`)} = ${type} and ${sql.raw(`${prefix}group_name`)} is not null`
  const nearest = (predicate: SQL, value: SQL) => sql`(
    select ${value} from ancestry where ${predicate} order by depth limit 1
  )`
  const fallback = (type: string, column = "group_name") => sql`(
    select t.${sql.identifier(column)} from ${traces} t where t.id = ${spans.traceId}
      and t.project_id = ${spans.projectId} and t.group_type = ${type}
  )`
  const groupName = (type: string) =>
    sql`coalesce(${nearest(groupMatch(type), sql`group_name`)}, ${fallback(type)})`
  const groupVersion = (type: string) =>
    sql`case when ${nearest(groupMatch(type), sql`group_name`)} is not null then ${nearest(groupMatch(type), sql`group_version`)} else ${fallback(type, "group_version")} end`
  const expressions: Record<string, SQL> = {
    functionName: sql`coalesce(${nearest(functionMatch(""), sql`coalesce(function_id, case when kind = 'function' then name else group_name end)`)}, ${fallback("agent")})`,
    agentName: groupName("agent"),
    workflowName: groupName("workflow"),
    stepName: nearest(sql`kind = 'task'`, sql`name`),
    agentVersion: groupVersion("agent"),
    workflowVersion: groupVersion("workflow"),
    // A scorer ancestor takes precedence over a nearer workload marker, so
    // role attribution must inspect the complete, cycle-safe ancestry.
    executionRole: sql`case when exists(select 1 from ancestry where execution_role = 'scorer') then 'scorer'
      when exists(select 1 from ancestry where execution_role = 'workload') then 'workload' end`,
  }
  const contexts = new Set(
    keys.map((key) => key.replace(/(Name|Version)$/, ""))
  )
  // A single nearest context is final as soon as it is found. Multi-context
  // queries keep walking so an older workflow or task can still be resolved.
  const context = contexts.size === 1 ? [...contexts][0] : undefined
  const resolved =
    context === "function"
      ? functionMatch("a.")
      : context === "agent" || context === "workflow"
        ? groupMatch(context, "a.")
        : context === "step"
          ? sql`a.kind = 'task'`
          : undefined
  return {
    fields,
    join: sql`left join lateral (
      with recursive ancestry as (
        select ${spans.id} as id, ${spans.parentId} as parent_id, ${spans.name} as name,
          ${spans.kind} as kind, ${spans.groupType} as group_type, ${spans.groupName} as group_name,
          ${spans.groupVersion} as group_version, ${functionId(sql`${spans.attributesJson}`)} as function_id,
          ${executionRole(sql`${spans.attributesJson}`, sql`${spans.kind}`)} as execution_role,
          0 as depth, array[${spans.id}]::text[] as path
        union all
        select p.id, p.parent_id, p.name, p.kind, p.group_type, p.group_name, p.group_version,
          ${functionId(sql`p.attributes_json`)}, ${executionRole(sql`p.attributes_json`, sql`p.kind`)},
          a.depth + 1, a.path || p.id
        from ancestry a join ${spans} p on p.id = a.parent_id
          and p.project_id = ${spans.projectId} and p.trace_id = ${spans.traceId}
        where not p.id = any(a.path)
          ${resolved ? sql`and not coalesce((${resolved}), false)` : sql``}
      )
      select ${sql.join(
        keys.map((key) => sql`${expressions[key]} as ${sql.identifier(key)}`),
        sql`, `
      )}
    ) attribution on true`,
  }
}

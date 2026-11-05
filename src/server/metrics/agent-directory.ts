import { agentDirectoryDimensions } from "@/src/lib/tracer/performance-table"
import { sql } from "drizzle-orm"
import { createSemanticCatalog } from "@/src/lib/semantic/catalog"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { fullTextSqlField } from "@/src/server/semantic/full-text-filter"
import { executeSqlPage } from "@/src/server/semantic/sql-page"
import { agentsSemanticModel } from "./performance"
import { performanceFactsSql, performanceMeasureSql } from "./performance-sql"
import { invocationSqlField } from "./group-filter"
import { metricWindow, quality } from "./common"

/** Private to the workspace directory; public analytical queries retain their original grain. */
export const agentDirectoryCatalog = createSemanticCatalog([
  {
    ...agentsSemanticModel,
    members: [
      ...agentsSemanticModel.members,
      ...agentDirectoryDimensions.slice(1).map((name) => ({
        name,
        title: name.split(".")[1],
        description: "Agent directory identity.",
        definition: "Project-scoped directory identity and saved agent status.",
        kind: "dimension" as const,
        type: "string" as const,
        groupable: true,
        filterOperators: [],
        metricVersion: "v1",
      })),
    ],
    async execute(query, context) {
      if (
        query.dimensions.length !== agentDirectoryDimensions.length ||
        !agentDirectoryDimensions.every((dimension) =>
          query.dimensions.includes(dimension)
        ) ||
        query.timeDimensions.some((dimension) => dimension.granularity)
      )
        throw new SemanticModelQueryError(
          "MODEL_QUERY_INVALID",
          "The agent directory groups by agent name without time buckets."
        )
      const project = context.snapshot.projectId
      const window = metricWindow(query, "agents.startedAt")
      const raw = sql`
      select id, id as trace_id, null::text as parent_id, group_name, group_version,
        group_type as kind, 'trace'::text as source, status, started_at_ms, ended_at_ms,
        reported_cost_usd, cost_present, attributes_json::jsonb->>'build.agent.id' as agent_id
      from traces where project_id = ${project} and group_type = 'agent' and group_name is not null
        and started_at_ms >= ${window.fromMs} and started_at_ms < ${window.toMs}
      union all
      select s.id, s.trace_id, s.parent_id, s.group_name, s.group_version, s.kind,
        'span'::text as source, s.status, s.started_at_ms, s.ended_at_ms,
        s.reported_cost_usd, s.cost_present,
        coalesce(s.attributes_json::jsonb->>'build.agent.id', case when s.group_name = t.group_name then t.attributes_json::jsonb->>'build.agent.id' end) as agent_id
      from spans s left join traces t on t.project_id = s.project_id and t.id = s.trace_id
      where s.project_id = ${project} and s.group_type = 'agent' and s.group_name is not null
        and s.started_at_ms >= ${window.fromMs} and s.started_at_ms < ${window.toMs}`
      // An explicit ID takes precedence. Older instrumentation can match one exact
      // slug/name, but ambiguous names never collapse distinct created agents.
      const resolved = sql`select r.id, r.trace_id, r.parent_id, r.group_version, r.kind,
      r.source, r.status, r.started_at_ms, r.ended_at_ms, r.reported_cost_usd, r.cost_present,
      case when a.id is not null then 'managed:' || a.id else 'traced:' || r.group_name end as group_name,
      coalesce(a.name, r.group_name) as display_name, r.group_name as original_name
      from (${raw}) r
      left join lateral (
        select min(candidate.id) as id from build_agents candidate
        where candidate.project_id = ${project} and (
          case when r.agent_id is not null then candidate.id = r.agent_id
            else candidate.slug = r.group_name or candidate.name = r.group_name end)
        having count(*) = 1
      ) matched on true
      left join build_agents a on a.project_id = ${project} and a.id = matched.id`
      const fields: Record<string, SqlFilterField> = {
        "agents.name": {
          value: sql`display_name`,
          type: "string",
          caseSensitive: true,
        },
        "agents.version": {
          value: sql`group_version`,
          type: "string",
          caseSensitive: true,
        },
        "agents.status": {
          value: sql`status`,
          type: "string",
          caseSensitive: true,
        },
        "agents.source": {
          value: sql`source`,
          type: "string",
          caseSensitive: true,
        },
        "agents.traceId": {
          value: sql`trace_id`,
          type: "string",
          caseSensitive: true,
        },
        "agents.invocationId": {
          value: sql`id`,
          type: "string",
          caseSensitive: true,
        },
        "agents.invocationGroup": invocationSqlField(
          sql`${project}`,
          sql`invocations.trace_id`,
          "agent"
        ),
      }
      fields["agents.fullText"] = fullTextSqlField([
        fields["agents.name"],
        fields["agents.version"],
        { value: sql`original_name`, type: "string" },
      ])
      const roots = sql`select * from (${resolved}) invocations where ${semanticSqlFilters(query.filters, fields)}`
      const facts = performanceFactsSql(
        roots,
        "agents",
        { ...query, dimensions: ["agents.name"] },
        project
      )
      const grouped = sql`select "agents.name" as identity,
      ${sql.join(
        query.measures.map(
          (member) =>
            sql`${performanceMeasureSql[member.split(".")[1] as keyof typeof performanceMeasureSql]} as ${sql.identifier(member)}`
        ),
        sql`, `
      )}
      from (${facts}) facts group by "agents.name"`
      const candidates = sql`select 'managed:' || a.id as identity, a.id as managed_id,
        a.name as display_name, a.slug as original_name, a.status as managed_status,
        null::text as group_version, null::text as status, null::text as source,
        null::text as trace_id, null::text as id
      from build_agents a where a.project_id = ${project}`
      const emptyMeasures = sql`select ${sql.join(
        query.measures.map(
          (member) =>
            sql`${performanceMeasureSql[member.split(".")[1] as keyof typeof performanceMeasureSql]} as ${sql.identifier(member)}`
        ),
        sql`, `
      )} from (${facts}) facts where false`
      const relation = sql`with grouped as (${grouped}), empty_metrics as (${emptyMeasures}),
      directory as (
        select identity, managed_id, display_name, managed_status from (${candidates}) invocations
        where ${semanticSqlFilters(query.filters, fields)}
        union
        select g.identity, a.id, coalesce(a.name, substring(g.identity from 8)), a.status
        from grouped g left join build_agents a on a.project_id = ${project} and g.identity = 'managed:' || a.id
      )
      select null::text as "agents.startedAt", d.identity as "agents.identity", d.managed_id as "agents.managedId",
        d.managed_status as "agents.managedStatus", d.display_name as "agents.name",
        a.current_config_json #>> '{appearance,avatarUrl}' as "agents.avatarUrl",
        a.current_config_json #>> '{appearance,avatarStyle}' as "agents.avatarStyle",
        a.current_config_json #>> '{appearance,avatarColor}' as "agents.avatarColor",
        ${sql.join(
          query.measures.map(
            (member) =>
              sql`case when g.identity is null then e.${sql.identifier(member)} else g.${sql.identifier(member)} end as ${sql.identifier(member)}`
          ),
          sql`, `
        )}
      from directory d
      left join build_agents a on a.project_id = ${project} and a.id = d.managed_id
      left join grouped g on g.identity = d.identity cross join empty_metrics e`
      // Distinct agents can have the same label: use identity as the final tie-break.
      const page = await executeSqlPage(
        relation,
        {
          ...query,
          order: [...query.order, ["agents.identity", "asc"]],
        },
        context
      )
      return {
        ...page,
        quality: quality(
          [
            "Created agents appear even without operations in the time range. Traced activity is joined by saved agent ID, or one unambiguous exact slug/name for older instrumentation.",
            "Performance measures retain the invocation latency, lifecycle and inclusive reported-cost definitions.",
          ],
          []
        ),
      }
    },
  },
])

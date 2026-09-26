import { sql } from "drizzle-orm"
import type { SemanticFilterCondition } from "@/src/lib/semantic/query"
import {
  defineSemanticModel,
  type SemanticMemberDefinition,
} from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "../semantic/sql-filters"
import { aggregateSql, sqlDay } from "./aggregate-sql"
import {
  labelFilterOperators,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  metricWindow,
  quality,
} from "./common"

const limitations = [
  "Uses saved case-level workflow/agent and workload-model attribution. Historical runs without saved attribution are excluded until backfilled.",
  "Scores describe the evaluated case, including any participating nested groups; they do not independently score each child operation. Groups overlap, so grouped counts must not be summed.",
  "Model is observed workload telemetry, never the judge model or a configured-but-unobserved prompt model. Cases with multiple observed models stay in a Multiple models bucket; missing telemetry stays Unknown model.",
  "Mean score averages valid numeric scores from 0 through 1, including zero, weighted by evaluator result. Select the same scorer/version and comparable cases when comparing models.",
] as const

const dimensions = {
  groupType: ["Operation type", "Saved operation type: workflow or agent."],
  groupName: [
    "Operation",
    "Saved workflow or agent name in the evaluated scope.",
  ],
  groupVersion: ["Operation version", "Saved workflow or agent version."],
  model: ["Evaluated model", "Observed model used by the evaluated workload."],
  groupModel: [
    "Operation and model",
    "Operation name and evaluated model, for category charts.",
  ],
  evaluatorId: ["Scorer ID", "Historical scorer identity."],
  evaluatorName: ["Scorer", "Current scorer display name."],
  evaluatorVersion: [
    "Scorer version",
    "Historical scorer version used for the result.",
  ],
  runId: ["Eval run ID", "Evaluation run containing the scored case."],
} as const

const measures = [
  [
    "meanScore",
    "Average score",
    "average",
    "ratio",
    "fraction",
    "Arithmetic mean of valid persisted scores from 0 through 1, including zero.",
  ],
  [
    "scoredCount",
    "Scored results",
    "count",
    "integer",
    "results",
    "Count of evaluator results with a valid persisted score from 0 through 1.",
  ],
  [
    "executionCount",
    "Scorer executions",
    "count",
    "integer",
    "results",
    "Count of evaluator results with saved target attribution.",
  ],
  [
    "errorCount",
    "Scorer errors",
    "count",
    "integer",
    "results",
    "Count of attributed evaluator results with status error; explicit failed checks are not technical errors.",
  ],
] as const

function groupMembershipField(
  project: string,
  type: "workflow" | "agent"
): SqlFilterField {
  return {
    value: sql`a.group_name`,
    type: "string",
    predicate: (filter: SemanticFilterCondition) => {
      const positive = {
        notEquals: "equals",
        notIn: "in",
        notContains: "contains",
        notSet: "set",
      } as const
      const negative = filter.operator in positive
      const condition = {
        ...filter,
        member: "name",
        operator:
          positive[filter.operator as keyof typeof positive] ?? filter.operator,
      }
      const matching = (value: ReturnType<typeof sql>) =>
        semanticSqlFilters([condition], {
          name: { value, type: "string", caseSensitive: false },
        })
      const member = sql`exists (select 1 from eval_target_attributions membership
        where membership.project_id=${project} and membership.run_id=r.run_id
        and membership.target_id=r.target_id and membership.group_type=${type}
        and ${matching(sql`membership.group_name`)})`
      // A workflow selection keeps its agent rows, but not unrelated workflows
      // recorded on the same case. The cohort is a case, never the entire run.
      return negative
        ? sql`not (${member})`
        : sql`(${member} and
        (a.group_type is distinct from ${type} or ${matching(sql`a.group_name`)}))`
    },
  }
}

export const evalQualitySemanticModel = defineSemanticModel({
  name: "evalQuality",
  version: "v1",
  defaultMeasures: ["evalQuality.meanScore", "evalQuality.scoredCount"],
  defaultOrder: [["evalQuality.meanScore", "desc"]],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...(["workflow", "agent"] as const).map(
      (type): SemanticMemberDefinition => ({
        name: `evalQuality.${type}`,
        title: type === "workflow" ? "Workflow" : "Agent",
        description: `Filter scored cases by saved ${type} name.`,
        definition: `Includes only cases with a matching saved ${type}. Other group types retain their attribution within those cases; other ${type} names are excluded. Negative filters exclude cases containing a matching ${type}.`,
        kind: "dimension",
        type: "string",
        groupable: false,
        filterOperators: labelFilterOperators,
        metricVersion: "v1",
        limitations,
      })
    ),
    ...measures.map(
      ([
        key,
        title,
        aggregation,
        format,
        unit,
        definition,
      ]): SemanticMemberDefinition => ({
        name: `evalQuality.${key}`,
        title,
        description: definition,
        definition,
        kind: "measure",
        type: "number",
        aggregation,
        format,
        unit,
        basis: "saved_eval_target_attribution",
        metricVersion: "v1",
        limitations,
      })
    ),
    ...Object.entries(dimensions).map(
      ([key, [title, description]]): SemanticMemberDefinition => ({
        name: `evalQuality.${key}`,
        title,
        description,
        definition: description,
        kind: "dimension",
        type: "string",
        groupable: true,
        filterOperators: labelFilterOperators,
        metricVersion: "v1",
        limitations,
      })
    ),
    {
      name: "evalQuality.completedAt",
      title: "Completed at",
      description: "Result completion time.",
      definition:
        "Persisted result completion timestamp, falling back to creation time.",
      kind: "timeDimension",
      type: "date",
      granularities: ["day"],
      metricVersion: "v1",
      limitations,
    },
  ],
  execute: async (query, context) => {
    const project = context.snapshot.projectId
    const window = metricWindow(query, "evalQuality.completedAt")
    const model = sql`case jsonb_array_length(a.models_json) when 0 then 'Unknown model' when 1 then a.models_json->>0 else 'Multiple models' end`
    const columns = {
      groupType: sql`a.group_type`,
      groupName: sql`a.group_name`,
      groupVersion: sql`a.group_version`,
      model,
      groupModel: sql`coalesce(a.group_name,'Unassigned') || ' · ' || ${model}`,
      evaluatorId: sql`r.evaluator_id`,
      evaluatorName: sql`e.name`,
      evaluatorVersion: sql`v.version::text`,
      runId: sql`r.run_id`,
    }
    const fields: Record<string, SqlFilterField> = Object.fromEntries(
      Object.entries(columns).map(([key, value]) => [
        `evalQuality.${key}`,
        { value, type: "string", caseSensitive: key !== "groupName" },
      ])
    )
    fields["evalQuality.workflow"] = groupMembershipField(project, "workflow")
    fields["evalQuality.agent"] = groupMembershipField(project, "agent")
    // DISTINCT is at result + selected dimensions, not result + every membership:
    // filtering on two groups or omitting versions must never multiply a score.
    const facts = sql`select distinct r.id, r.status,
      case when s.status='ok' and s.value between 0 and 1 then s.value end as score,
      ${sqlDay(query, "evalQuality.completedAt", sql`r.event_at_ms`)} as "evalQuality.completedAt"
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
      from eval_results r
      join eval_target_attributions a on a.project_id=${project} and a.run_id=r.run_id and a.target_id=r.target_id
      left join scores s on s.project_id=${project} and s.eval_result_id=r.id and s.name='score'
      left join evaluators e on e.project_id=${project} and e.id=r.evaluator_id
      left join evaluator_versions v on v.project_id=${project} and v.id=r.evaluator_version_id
      where r.project_id=${project} and r.event_at_ms>=${window.fromMs} and r.event_at_ms<${window.toMs}
      and ${semanticSqlFilters(query.filters, fields)}`
    const page = await aggregateSql(
      query,
      context,
      facts,
      "evalQuality.completedAt",
      {
        meanScore: sql`avg(score)`,
        scoredCount: sql`count(score)`,
        executionCount: sql`count(*)`,
        errorCount: sql`count(*) filter(where status='error')`,
      }
    )
    return { ...page, quality: quality(limitations, page.warnings) }
  },
})

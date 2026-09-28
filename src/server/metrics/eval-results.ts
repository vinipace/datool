import { sql } from "drizzle-orm"
import { defineSemanticModel } from "@/src/lib/semantic/model"
import { invocationFilterMember } from "@/src/lib/semantic/group-filter"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, sqlDay } from "./aggregate-sql"
import {
  sourceDimension,
  sourceMeasures,
  sourceTime,
  metadataDimension,
} from "./source-contract"
import { savedMembershipFields } from "./saved-context"
import {
  metricWindow,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
} from "./common"

const limitations = [
  "All scorer results, including historical results without saved attribution. Unknown context never falls back to current trace memberships.",
  "Scores describe a case. Participating operation groups can overlap; do not sum grouped counts.",
  "Evaluated model is workload telemetry; multiple recorded models form one Multiple models bucket. Select a consistent scorer and version for score comparisons.",
  "Prompt versions come from saved workload provenance within each evaluated case. Multiple recorded versions form one Multiple prompt versions bucket. Missing historical provenance remains unknown; participating operations share the case score.",
]
export const evalResultsSemanticModel = defineSemanticModel({
  name: "evalResults",
  version: "v1",
  defaultMeasures: ["evalResults.executionCount"],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...sourceMeasures(
      "evalResults",
      [
        [
          "executionCount",
          "Evaluation results",
          "count",
          "results",
          "All persisted scorer executions, including errors and unattributed historical results.",
        ],
        [
          "scoredCount",
          "Scored results",
          "count",
          "results",
          "Results with a valid native numeric score from zero through one.",
        ],
        [
          "meanScore",
          "Average score",
          "average",
          "ratio",
          "Mean of valid normalized native scores, including zero. Select a consistent scorer/version.",
          "Results with a valid numeric score",
        ],
        [
          "p50Score",
          "P50 score",
          "percentile",
          "ratio",
          "Median of valid scores in the selected population. Compare within one scorer version.",
        ],
        [
          "p95Score",
          "P95 score",
          "percentile",
          "ratio",
          "95th percentile of valid scores; the upper end of quality, not worst-case performance.",
        ],
        [
          "explicitPassCount",
          "Passed checks",
          "count",
          "results",
          "Results with explicit passed=true.",
        ],
        [
          "explicitFailCount",
          "Failed checks",
          "count",
          "results",
          "Results with explicit passed=false.",
        ],
        [
          "explicitPassRate",
          "Check pass rate",
          "ratio",
          "ratio",
          "Explicit passes divided by results with an explicit true or false outcome.",
          "Results with an explicit pass outcome",
        ],
        [
          "errorCount",
          "Scorer errors",
          "count",
          "results",
          "Results with technical error status, independent of failed quality checks.",
        ],
        [
          "errorRate",
          "Scorer error rate",
          "ratio",
          "ratio",
          "Technical errors divided by terminal scorer results.",
          "Completed, passed, failed or error results",
        ],
        [
          "uniqueTraceCount",
          "Evaluated traces",
          "countDistinct",
          "traces",
          "Distinct trace identities with results.",
        ],
        [
          "uniqueCaseCount",
          "Evaluated cases",
          "countDistinct",
          "cases",
          "Distinct linked run/target identities. Historical unlinked results cannot establish case identity.",
        ],
        [
          "attributedCount",
          "Attributed results",
          "count",
          "results",
          "Results with saved evaluation-time case attribution.",
        ],
        [
          "unattributedCount",
          "Unattributed results",
          "count",
          "results",
          "Results without saved case attribution.",
        ],
        [
          "attributionCoverage",
          "Attribution coverage",
          "ratio",
          "ratio",
          "Results with saved case attribution divided by all results.",
          "All evaluation results",
        ],
      ],
      "project + result",
      "Result completion, falling back to creation"
    ),
    ...[
      ["id", "Result ID"],
      ["runId", "Evaluation run ID"],
      ["evalRunName", "Evaluation run"],
      ["targetId", "Case ID"],
      ["traceId", "Trace ID"],
      ["datasetId", "Dataset ID"],
      ["datasetName", "Dataset"],
      ["datasetItemId", "Dataset item ID"],
      ["evaluatorId", "Scorer ID"],
      ["evaluatorName", "Scorer"],
      ["evaluatorVersionId", "Scorer version ID"],
      ["evaluatorVersion", "Scorer version"],
      ["status", "Result status"],
      ["groupType", "Operation type"],
      ["groupName", "Operation"],
      ["groupVersion", "Operation version"],
      ["model", "Evaluated model"],
      ["promptId", "Prompt ID"],
      ["promptVersion", "Prompt version"],
      ["groupModel", "Operation and model"],
    ].map(([key, title]) =>
      sourceDimension(
        "evalResults",
        key,
        title,
        `${title} for the evaluated case. Operation and model context is saved at evaluation time.`,
        {
          source:
            key.startsWith("group") || key === "model"
              ? "Saved case attribution"
              : "Evaluation result",
          multiplicity: key.startsWith("group") ? "many" : "one",
          ...(key.startsWith("group") ? { overlap: limitations[1] } : {}),
        }
      )
    ),
    ...["agent", "workflow", "containsModel"].map((key) =>
      sourceDimension(
        "evalResults",
        key,
        key === "containsModel"
          ? "Contains evaluated model"
          : key === "agent"
            ? "Agent"
            : "Workflow",
        "Filter cases by saved attribution without multiplying results.",
        { groupable: false }
      )
    ),
    invocationFilterMember("evalResults", "v1"),
    metadataDimension(
      "evalResults",
      "metadata",
      "Result metadata",
      "Recorded metadata on the scorer result."
    ),
    metadataDimension(
      "evalResults",
      "caseMetadata",
      "Saved case metadata",
      "Frozen case snapshot. Historical missing snapshots remain unavailable."
    ),
    sourceTime(
      "evalResults",
      "completedAt",
      "Completed at",
      "Persisted completion time, falling back to creation."
    ),
  ],
  execute: async (query, context) => {
    const project = context.snapshot.projectId,
      window = metricWindow(query, "evalResults.completedAt")
    // A single saved model set when no operation grouping is requested. Never fan a score out over its models.
    const operationGrouping = query.dimensions.some((d) =>
      [
        "evalResults.groupName",
        "evalResults.groupType",
        "evalResults.groupVersion",
        "evalResults.groupModel",
      ].includes(d)
    )
    const model = sql`case jsonb_array_length(models.models) when 0 then null when 1 then models.models->>0 else 'Multiple models' end`
    const columns = {
      id: sql`r.id`,
      runId: sql`r.run_id`,
      evalRunName: sql`runs.name`,
      targetId: sql`r.target_id`,
      traceId: sql`r.trace_id`,
      datasetName: sql`dataset.name`,
      datasetId: sql`coalesce(item.dataset_id,runs.dataset_id)`,
      datasetItemId: sql`r.dataset_item_id`,
      evaluatorId: sql`r.evaluator_id`,
      evaluatorName: sql`e.name`,
      evaluatorVersionId: sql`r.evaluator_version_id`,
      evaluatorVersion: sql`v.version::text`,
      status: sql`r.status`,
      groupType: sql`a.group_type`,
      groupName: sql`a.group_name`,
      groupVersion: sql`a.group_version`,
      model,
      promptId: sql`case jsonb_array_length(prompts.versions) when 1 then prompts.versions->0->>'id' else null end`,
      promptVersion: sql`case jsonb_array_length(prompts.versions) when 0 then null when 1 then (prompts.versions->0->>'slug') || ' v' || (prompts.versions->0->>'version') else 'Multiple prompt versions' end`,
      groupModel: sql`coalesce(a.group_name,'Unknown') || ' · ' || coalesce(${model},'Unknown model')`,
    }
    const fields: Record<string, SqlFilterField> = {
      ...Object.fromEntries(
        Object.entries(columns).map(([key, value]) => [
          `evalResults.${key}`,
          { value, type: "string" as const, caseSensitive: true },
        ])
      ),
      ...savedMembershipFields(
        "evalResults",
        project,
        sql`r.run_id`,
        sql`r.target_id`
      ),
      "evalResults.metadata": { value: sql`r.metadata_json`, type: "json" },
      "evalResults.caseMetadata": { value: sql`t.snapshot_json`, type: "json" },
    }
    // LEFT JOIN all results, then DISTINCT by result plus selected dimensions removes membership fanout.
    const facts = sql`select distinct r.id,r.status,r.passed,r.trace_id,r.target_id,r.run_id,
      exists(select 1 from eval_target_attributions saved where saved.project_id=${project} and saved.run_id=r.run_id and saved.target_id=r.target_id) as attributed,
      case when s.status='ok' and s.value between 0 and 1 then s.value end as score,
      ${sqlDay(query, "evalResults.completedAt", sql`r.event_at_ms`)} as "evalResults.completedAt"
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
      left join eval_target_attributions a on a.project_id=${project} and a.run_id=r.run_id and a.target_id=r.target_id
      left join lateral (select coalesce(jsonb_agg(distinct model.value),'[]'::jsonb) as models from eval_target_attributions saved cross join lateral jsonb_array_elements(saved.models_json) model(value)
        where saved.project_id=${project} and saved.run_id=r.run_id and saved.target_id=r.target_id ${operationGrouping ? sql`and saved.group_type is not distinct from a.group_type and saved.group_name is not distinct from a.group_name and saved.group_version is not distinct from a.group_version` : sql``}) models on true
      left join scores s on s.project_id=${project} and s.eval_result_id=r.id and s.name='score'
      ${
        JSON.stringify(query).includes("evalResults.prompt")
          ? sql`left join lateral (select coalesce(jsonb_agg(distinct p.value),'[]'::jsonb) as versions from eval_target_attributions saved cross join lateral jsonb_array_elements(saved.prompt_versions_json) p(value)
        where saved.project_id=${project} and saved.run_id=r.run_id and saved.target_id=r.target_id) prompts on true`
          : sql``
      }
      left join evaluators e on e.project_id=${project} and e.id=r.evaluator_id
      left join evaluator_versions v on v.project_id=${project} and v.id=r.evaluator_version_id
      left join dataset_items item on item.project_id=${project} and item.id=r.dataset_item_id
      left join eval_runs runs on runs.project_id=${project} and runs.id=r.run_id
      left join datasets dataset on dataset.project_id=${project} and dataset.id=coalesce(item.dataset_id,runs.dataset_id)
      left join eval_run_targets t on t.project_id=${project} and t.run_id=r.run_id and t.id=r.target_id
      where r.project_id=${project} and r.event_at_ms>=${window.fromMs} and r.event_at_ms<${window.toMs} and ${semanticSqlFilters(query.filters, fields)}`
    const { warnings, ...page } = await aggregateSql(
      query,
      context,
      facts,
      "evalResults.completedAt",
      {
        executionCount: sql`count(*)`,
        scoredCount: sql`count(score)`,
        // Decimal accumulation keeps equal scores tied across query plans,
        // before SQL applies ranking, HAVING and page boundaries.
        meanScore: sql`avg(score::numeric)`,
        p50Score: sql`percentile_cont(0.5) within group(order by score)`,
        p95Score: sql`percentile_cont(0.95) within group(order by score)`,
        explicitPassCount: sql`count(*) filter(where passed is true)`,
        explicitFailCount: sql`count(*) filter(where passed is false)`,
        explicitPassRate: sql`count(*) filter(where passed is true)::double precision/nullif(count(passed),0)`,
        errorCount: sql`count(*) filter(where status='error')`,
        errorRate: sql`count(*) filter(where status='error')::double precision/nullif(count(*) filter(where status in ('completed','passed','failed','error')),0)`,
        uniqueTraceCount: sql`count(distinct trace_id)`,
        uniqueCaseCount: sql`count(distinct (run_id,target_id)) filter(where target_id is not null)`,
        attributedCount: sql`count(*) filter(where attributed)`,
        unattributedCount: sql`count(*) filter(where not attributed)`,
        attributionCoverage: sql`count(*) filter(where attributed)::double precision/nullif(count(*),0)`,
      }
    )
    return { ...page, quality: quality(limitations, warnings) }
  },
})

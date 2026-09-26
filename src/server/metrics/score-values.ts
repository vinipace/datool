import { sql } from "drizzle-orm"
import {
  defineSemanticModel,
  SemanticModelQueryError,
} from "@/src/lib/semantic/model"
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
import {
  metricWindow,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
} from "./common"

const limitations = [
  "Current saved ratings. Editing a review replaces its value and event time; this is not a history of edits.",
  "Numeric aggregates require a single compatible definition or grouping by definition. Imported scores without declared definitions have an individual unknown scale and cannot be averaged together.",
  "Multi-select categories overlap: a rating counts once globally and once in each selected category.",
]
const numericMeasures = new Set([
  "scoreValues.meanValue",
  "scoreValues.minValue",
  "scoreValues.maxValue",
])
export const scoreValuesSemanticModel = defineSemanticModel({
  name: "scoreValues",
  version: "v1",
  defaultMeasures: ["scoreValues.count"],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...sourceMeasures(
      "scoreValues",
      [
        [
          "count",
          "Saved ratings",
          "count",
          "ratings",
          "One saved rating, including each current review rating once.",
        ],
        [
          "numericCount",
          "Numeric ratings",
          "count",
          "ratings",
          "Valid numeric ratings, preserving their original scale.",
        ],
        [
          "booleanCount",
          "Boolean ratings",
          "count",
          "ratings",
          "Ratings with boolean values.",
        ],
        [
          "categoricalCount",
          "Categorical ratings",
          "count",
          "ratings",
          "Ratings with one or more categories.",
        ],
        [
          "textCount",
          "Text ratings",
          "count",
          "ratings",
          "Free-text ratings; these have no numeric value.",
        ],
        [
          "uniqueTargetCount",
          "Rated targets",
          "countDistinct",
          "targets",
          "Distinct targets; span identities include their parent trace.",
        ],
        [
          "meanValue",
          "Average numeric value",
          "average",
          "value",
          "Mean raw value within a compatible score definition and scale.",
          "Valid numeric ratings of the selected definition",
        ],
        [
          "minValue",
          "Minimum numeric value",
          "minimum",
          "value",
          "Minimum raw value within a compatible score definition and scale.",
        ],
        [
          "maxValue",
          "Maximum numeric value",
          "maximum",
          "value",
          "Maximum raw value within a compatible score definition and scale.",
        ],
        [
          "trueCount",
          "True ratings",
          "count",
          "ratings",
          "Boolean ratings with value true.",
        ],
        [
          "falseCount",
          "False ratings",
          "count",
          "ratings",
          "Boolean ratings with value false.",
        ],
        [
          "trueRate",
          "Boolean true rate",
          "ratio",
          "ratio",
          "True divided by all boolean ratings. This is not necessarily pass/fail.",
          "Boolean ratings",
        ],
      ],
      "project + origin + rating ID",
      "Creation; last update for current reviews"
    ).map((m) =>
      numericMeasures.has(m.name) ? { ...m, requiresDefinition: true } : m
    ),
    ...[
      ["id", "Rating ID"],
      ["name", "Score name"],
      ["definitionId", "Score definition"],
      ["type", "Value type"],
      ["scale", "Scale"],
      ["origin", "Origin"],
      ["authorType", "Author type"],
      ["reviewerId", "Reviewer ID"],
      ["targetKind", "Target kind"],
      ["targetId", "Target ID"],
      ["traceId", "Trace ID"],
      ["evaluatorId", "Scorer ID"],
      ["evaluatorName", "Scorer"],
      ["evaluatorVersionId", "Scorer version ID"],
      ["evaluatorVersion", "Scorer version"],
      ["runId", "Evaluation run ID"],
      ["status", "Rating status"],
      ["category", "Category"],
      ["text", "Rating text"],
    ].map(([key, title]) =>
      sourceDimension(
        "scoreValues",
        key,
        title,
        key === "category"
          ? limitations[2]
          : key === "evaluatorName"
            ? "Current scorer display name. Missing links remain Unknown."
            : `Recorded ${title.toLowerCase()} on the rating. Missing links remain Unknown.`,
        {
          ...(key === "category"
            ? { multiplicity: "many", overlap: limitations[2] }
            : {}),
          ...(key === "text" ? { groupable: false } : {}),
        }
      )
    ),
    sourceDimension(
      "scoreValues",
      "value",
      "Numeric value",
      "Original numeric value for filtering and distributions.",
      {
        type: "number",
        filterOperators: [
          "equals",
          "notEquals",
          "gt",
          "gte",
          "lt",
          "lte",
          "set",
          "notSet",
        ],
      }
    ),
    metadataDimension(
      "scoreValues",
      "metadata",
      "Rating metadata",
      "Imported metadata, native result metadata, or recorded review provenance; origins remain explicit."
    ),
    sourceTime(
      "scoreValues",
      "recordedAt",
      "Recorded at",
      "Creation for evaluator/imported ratings; last update for current reviews."
    ),
  ],
  execute: async (query, context) => {
    const project = context.snapshot.projectId,
      window = metricWindow(query, "scoreValues.recordedAt")
    const importedDefinition = sql`case when s.external_json->'definition'->>'id' is not null then 'import:' || jsonb_build_array(s.external_json->'source'->>'provider',s.external_json->'source'->>'instance',s.external_json->'source'->>'projectId',s.external_json->'definition')::text else 'unknown-import-scale:' || s.id end`
    const nativeTime = sql`s.event_at_ms`,
      reviewTime = sql`r.event_at_ms`
    const raw = sql`select (case when s.import_id is null then 'evaluator:' else 'import:' end)||s.id as id,s.name,
      case when s.import_id is null then 'evaluator:'||coalesce(e.evaluator_version_id,s.evaluator_id,'unknown:'||s.id)||':'||s.name else ${importedDefinition} end as definition_id,
      case when s.import_id is null then 'numeric' else s.external_json->'data'->>'type' end as type,
      case when s.import_id is null then '0–1' when s.external_json->'definition'->>'min' is not null and s.external_json->'definition'->>'max' is not null then (s.external_json->'definition'->>'min')||'–'||(s.external_json->'definition'->>'max') else 'Unknown scale' end as scale,
      case when s.import_id is null then 'evaluator' else 'import' end as origin,
      case when s.import_id is null then 'scorer' else null end as author_type, null::text as reviewer_id,
      case when s.import_id is not null then s.external_json->'target'->>'type' else 'trace' end as target_kind,
      case when s.import_id is not null then s.external_json->'target'->>'id' else s.trace_id end as target_id,
      s.trace_id,s.evaluator_id,e.evaluator_version_id,coalesce(s.eval_run_id,e.run_id) as run_id,s.status,
      case when s.status='ok' and (s.import_id is null or s.external_json->'data'->>'type'='numeric') and s.value > '-Infinity'::float8 and s.value < 'Infinity'::float8 then s.value end as value,
      case when s.external_json->'data'->>'type'='boolean' then (s.external_json->'data'->>'value')::boolean end as boolean_value,
      case when s.external_json->'data'->>'type'='categorical' then jsonb_build_array(s.external_json->'data'->'value') else '[]'::jsonb end as categories,
      case when s.external_json->'data'->>'type'='text' then s.external_json->'data'->>'value' end as text,
      coalesce(s.external_json->'metadata',${sql`case when pg_input_is_valid(e.metadata_json,'jsonb') then e.metadata_json::jsonb end`},'{}'::jsonb) as metadata,
      ${nativeTime} as event_ms,scorer.name as evaluator_name,version.version::text as evaluator_version
      from scores s left join eval_results e on e.project_id=${project} and e.id=s.eval_result_id
      left join evaluators scorer on scorer.project_id=${project} and scorer.id=s.evaluator_id
      left join evaluator_versions version on version.project_id=${project} and version.id=e.evaluator_version_id
      where s.project_id=${project} and ${nativeTime}>=${window.fromMs} and ${nativeTime}<${window.toMs}
      union all
      select 'review:'||r.id,r.name,'review:'||r.human_score_id||':'||md5(r.definition_json::text),r.definition_json->>'type',
      case when r.definition_json->>'type'='numeric' then (r.definition_json->>'min')||'–'||(r.definition_json->>'max') else null end,
      'review',r.source,r.reviewer_id,'trace',r.trace_id,r.trace_id,r.scorer_id,null::text,null::text,'ok',
      case when r.definition_json->>'type'='numeric' and jsonb_typeof(r.human_value)='number' then (r.human_value #>> '{}')::double precision end,
      null::boolean,
      case when r.definition_json->>'type'='categorical' then case when jsonb_typeof(r.human_value)='array' then r.human_value else jsonb_build_array(r.human_value) end else '[]'::jsonb end,
      case when r.definition_json->>'type'='text' then r.human_value #>> '{}' end,
      coalesce(r.provenance_json,'{}'::jsonb),${reviewTime},null::text,null::text
      from review_scores r where r.project_id=${project} and ${reviewTime}>=${window.fromMs} and ${reviewTime}<${window.toMs}`
    const columns = {
      id: "id",
      name: "name",
      definitionId: "definition_id",
      type: "type",
      scale: "scale",
      origin: "origin",
      authorType: "author_type",
      reviewerId: "reviewer_id",
      targetKind: "target_kind",
      targetId: "target_id",
      traceId: "trace_id",
      evaluatorId: "evaluator_id",
      evaluatorName: "evaluator_name",
      evaluatorVersionId: "evaluator_version_id",
      evaluatorVersion: "evaluator_version",
      runId: "run_id",
      status: "status",
      text: "text",
    }
    const fields: Record<string, SqlFilterField> = {
      ...Object.fromEntries(
        Object.entries(columns).map(([key, column]) => [
          `scoreValues.${key}`,
          {
            value: sql`ratings.${sql.identifier(column)}`,
            type: "string" as const,
            caseSensitive: true,
          },
        ])
      ),
      "scoreValues.value": { value: sql`ratings.value`, type: "number" },
      "scoreValues.metadata": {
        value: sql`ratings.metadata`,
        type: "json",
        nativeJson: true,
      },
      "scoreValues.category": {
        value: sql`category.value`,
        type: "string",
        caseSensitive: true,
      },
    }
    const facts = sql`select distinct ratings.id,ratings.type,ratings.value,ratings.boolean_value,ratings.target_kind,ratings.target_id,ratings.trace_id,ratings.definition_id,
      ${sqlDay(query, "scoreValues.recordedAt", sql`ratings.event_ms`)} as "scoreValues.recordedAt"
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
      from (${raw}) ratings left join lateral jsonb_array_elements_text(ratings.categories) category(value) on true
      where ${semanticSqlFilters(query.filters, fields)}`
    if (
      query.measures.some((m) => numericMeasures.has(m)) &&
      !query.dimensions.includes("scoreValues.definitionId")
    ) {
      const incompatible = await context.snapshot.execute(
        sql`select count(distinct definition_id) as definitions from (${facts}) f where value is not null`
      )
      if (Number(incompatible.rows[0]?.definitions) > 1)
        throw new SemanticModelQueryError(
          "MODEL_QUERY_INVALID",
          "Numeric ratings have different definitions or scales. Filter to one Score definition, or group by Score definition.",
          ["dimensions"]
        )
    }
    const { warnings, ...page } = await aggregateSql(
      query,
      context,
      facts,
      "scoreValues.recordedAt",
      {
        count: sql`count(*)`,
        numericCount: sql`count(value)`,
        booleanCount: sql`count(boolean_value)`,
        categoricalCount: sql`count(*) filter(where type='categorical')`,
        textCount: sql`count(*) filter(where type='text')`,
        uniqueTargetCount: sql`count(distinct (target_kind,target_id,case when target_kind='span' then trace_id end)) filter(where target_id is not null)`,
        meanValue: sql`avg(value)`,
        minValue: sql`min(value)`,
        maxValue: sql`max(value)`,
        trueCount: sql`count(*) filter(where boolean_value is true)`,
        falseCount: sql`count(*) filter(where boolean_value is false)`,
        trueRate: sql`count(*) filter(where boolean_value is true)::double precision/nullif(count(boolean_value),0)`,
      },
      ["scoreValues.value"]
    )
    return { ...page, quality: quality(limitations, warnings) }
  },
})

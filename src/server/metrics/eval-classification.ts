import { sql, type SQL } from "drizzle-orm"
import { defineSemanticModel } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  safeJson,
  instantMs,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, sqlDay } from "./aggregate-sql"
import {
  sourceDimension,
  sourceMeasures,
  sourceTime,
  type MeasureSpec,
} from "./source-contract"
import {
  metricWindow,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
} from "./common"

const dimensions = {
  runId: "Run ID",
  runName: "Run",
  datasetId: "Dataset ID",
  datasetName: "Dataset",
  caseId: "Case ID",
  groupName: "Operation",
  groupVersion: "Candidate",
  actual: "Actual class",
  predicted: "Predicted class",
  outcome: "Confusion category",
}
const counts = {
  caseCount: "All cases",
  validCount: "Valid labels",
  missingCount: "Excluded labels",
  tp: "True positives",
  fp: "False positives",
  fn: "False negatives",
  tn: "True negatives",
  predictedPositiveCount: "Predicted positives",
  actualPositiveCount: "Actual positives",
  syntheticCount: "Synthetic cases",
  costCount: "Cases with cost",
}
const ratios = {
  precision: ["Precision", "TP / (TP + FP)", "Predicted positives"],
  recall: ["Recall", "TP / (TP + FN)", "Actual positives"],
  f1: [
    "F1",
    "2 TP / (2 TP + FP + FN)",
    "Twice true positives plus false positives and false negatives",
  ],
  accuracy: ["Accuracy", "(TP + TN) / valid labels", "Valid labels"],
} as const
const limitations = [
  "One immutable target snapshot per case execution. Explicit scalar label paths and a positive class define a one-vs-rest confusion matrix. Missing or differently typed labels are excluded, never counted as negatives.",
  "Repeated executions remain separate observations. Use paired comparisons for fixed dataset cases. Null ratios mean a zero denominator.",
  "Cost is recorded workload cost.usd in the target snapshot; absent, negative or nonnumeric costs are excluded. Synthetic counts identify explicitly tagged fixtures; zero does not establish real-world provenance.",
]

export const evalClassificationSemanticModel = defineSemanticModel({
  name: "evalClassification",
  version: "v1",
  defaultMeasures: ["evalClassification.precision"],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...sourceMeasures(
      "evalClassification",
      [
        ...Object.entries(counts).map(([key, title]): MeasureSpec => [
          key,
          title,
          "count",
          "cases",
          title + " from saved target labels.",
        ]),
        ...Object.entries(ratios).map(
          ([key, [title, definition, denominator]]): MeasureSpec => [
            key,
            title,
            "ratio",
            "ratio",
            definition,
            denominator,
          ]
        ),
        [
          "costUsd",
          "Recorded cost",
          "sum",
          "USD",
          "Sum of nonnegative recorded workload costs.",
        ],
        [
          "meanCostUsd",
          "Cost per case",
          "average",
          "USD",
          "Recorded workload cost divided by cases with valid cost.",
          "Cases with cost",
        ],
      ],
      "project + run + target",
      "Target creation"
    ),
    ...Object.entries(dimensions).map(([key, title]) =>
      sourceDimension(
        "evalClassification",
        key,
        title,
        "Saved case context or selected label."
      )
    ),
    sourceTime(
      "evalClassification",
      "createdAt",
      "Case time",
      "Target creation time."
    ),
  ],
  async execute(query, context) {
    const options = query.classification!
    const project = context.snapshot.projectId
    const window = metricWindow(query, "evalClassification.createdAt")
    const path = (keys: string[]) =>
      sql`snapshot #> ARRAY[${sql.join(
        keys.map((key) => sql`${key}::text`),
        sql`, `
      )}]`
    const positive = sql`${JSON.stringify(options.positiveClass)}::jsonb`
    const timestamp = instantMs(sql`t.created_at`)
    const columns: Record<string, SQL> = {
      runId: sql`run_id`,
      runName: sql`run_name`,
      datasetId: sql`dataset_id`,
      datasetName: sql`dataset_name`,
      caseId: sql`case_id`,
      groupName: sql`group_name`,
      groupVersion: sql`group_version`,
      actual: sql`actual #>> '{}'`,
      predicted: sql`predicted #>> '{}'`,
      outcome: sql`outcome`,
    }
    const fields = Object.fromEntries(
      Object.entries(columns).map(([key, value]) => [
        "evalClassification." + key,
        { value, type: "string" as const, caseSensitive: true },
      ])
    )
    const facts = sql`with snapshots as (
      select t.id, t.run_id, t.dataset_item_id as case_id, r.name as run_name,
        coalesce(item.dataset_id,r.dataset_id) as dataset_id, d.name as dataset_name,
        ${safeJson(sql`t.snapshot_json`)} as snapshot, ${timestamp} as event_ms,
        a.group_name, a.group_version
      from eval_run_targets t
      join eval_runs r on r.project_id=${project} and r.id=t.run_id
      left join dataset_items item on item.project_id=${project} and item.id=t.dataset_item_id
      left join datasets d on d.project_id=${project} and d.id=coalesce(item.dataset_id,r.dataset_id)
      left join lateral (select case when count(distinct group_name)=1 then min(group_name) end as group_name,
        case when count(distinct group_version)=1 then min(group_version) end as group_version
        from eval_target_attributions a where a.project_id=${project} and a.run_id=t.run_id and a.target_id=t.id) a on true
      where t.project_id=${project} and ${timestamp} >= ${window.fromMs} and ${timestamp} < ${window.toMs}
    ), labels as (
      select *, ${path(options.actualPath)} as actual, ${path(options.predictedPath)} as predicted,
        case when jsonb_typeof(snapshot #> '{trace,attributes,cost.usd}')='number' then (snapshot #>> '{trace,attributes,cost.usd}')::numeric end as raw_cost,
        coalesce(snapshot #> '{trace,attributes,synthetic}'='true'::jsonb,false) or coalesce(snapshot #> '{datasetItem,metadata,synthetic}'='true'::jsonb,false) as synthetic
      from snapshots
    ), outcomes as (
      select *, case when jsonb_typeof(actual) is distinct from jsonb_typeof(${positive}) or jsonb_typeof(predicted) is distinct from jsonb_typeof(${positive}) then 'missing'
        when actual=${positive} and predicted=${positive} then 'tp'
        when predicted=${positive} then 'fp' when actual=${positive} then 'fn' else 'tn' end as outcome,
        case when raw_cost>=0 then raw_cost end as cost
      from labels
    ) select outcome,synthetic,cost,
      ${sqlDay(query, "evalClassification.createdAt", sql`event_ms`)} as "evalClassification.createdAt"
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
      from outcomes where ${semanticSqlFilters(query.filters, fields)}`
    const count = (outcomes: string[]) =>
      sql`count(*) filter(where outcome in (${sql.join(
        outcomes.map((v) => sql`${v}`),
        sql`, `
      )}))`
    const tp = count(["tp"]),
      fp = count(["fp"]),
      fn = count(["fn"]),
      tn = count(["tn"]),
      valid = count(["tp", "fp", "fn", "tn"])
    const { warnings, ...page } = await aggregateSql(
      query,
      context,
      facts,
      "evalClassification.createdAt",
      {
        caseCount: sql`count(*)`,
        validCount: valid,
        missingCount: count(["missing"]),
        tp,
        fp,
        fn,
        tn,
        predictedPositiveCount: count(["tp", "fp"]),
        actualPositiveCount: count(["tp", "fn"]),
        precision: sql`${tp}::numeric/nullif(${tp}+${fp},0)`,
        recall: sql`${tp}::numeric/nullif(${tp}+${fn},0)`,
        f1: sql`2.0*${tp}/nullif(2*${tp}+${fp}+${fn},0)`,
        accuracy: sql`(${tp}+${tn})::numeric/nullif(${valid},0)`,
        costUsd: sql`sum(cost)`,
        meanCostUsd: sql`avg(cost)`,
        costCount: sql`count(cost)`,
        syntheticCount: sql`count(*) filter(where synthetic)`,
      },
      [],
      {
        missing: {
          predicate: sql`outcome='missing'`,
          message:
            "cases have missing or incompatible labels and are excluded from classification ratios.",
        },
      }
    )
    return { ...page, quality: quality(limitations, warnings) }
  },
})

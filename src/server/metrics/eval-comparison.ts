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
  datasetId: "Dataset ID",
  datasetName: "Dataset",
  caseId: "Case ID",
  status: "Pair status",
  outcome: "Change",
}
const counts = {
  caseCount: "Union of cases",
  matchedCount: "Matched cases",
  excludedCount: "Excluded cases",
  improvedCount: "Improved",
  regressedCount: "Regressed",
  unchangedCount: "Unchanged",
  syntheticCount: "Synthetic pairs",
}
const means = {
  baselineMean: "Baseline score",
  candidateMean: "Candidate score",
  meanDelta: "Paired score change",
  deltaCiLow: "Change · 95% lower bound",
  deltaCiHigh: "Change · 95% upper bound",
}
const limitations = [
  "Pairs match dataset ID plus item ID across disjoint run sets and one pinned scorer version. Both saved inputs and expected outputs must agree. Duplicate executions, absent cases, changed snapshots and absent scores are explicitly excluded.",
  "Deltas are candidate minus baseline. Improved/regressed respects lowerIsBetter; averages use only matched cases. A zero change is unchanged.",
  "Confidence bounds use a paired-mean normal approximation (1.96 standard errors), requiring at least 30 matched pairs and no tagged synthetic pairs. They assume independent representative cases, are not causal evidence, and are not simultaneous subgroup bounds. Null means unavailable, not zero uncertainty.",
]

export const evalComparisonSemanticModel = defineSemanticModel({
  name: "evalComparison",
  version: "v1",
  defaultMeasures: ["evalComparison.matchedCount"],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...sourceMeasures(
      "evalComparison",
      [
        ...Object.entries(counts).map(([key, title]): MeasureSpec => [
          key,
          title,
          "count",
          "cases",
          title + " over the union of selected dataset case identities.",
        ]),
        ...Object.entries(means).map(([key, title]): MeasureSpec => [
          key,
          title,
          "average",
          "ratio",
          title +
            " on matched cases only. Confidence bounds follow the documented paired normal approximation.",
          "Matched cases",
        ]),
      ],
      "project + dataset + case",
      "Latest selected target time for the pair"
    ),
    ...Object.entries(dimensions).map(([key, title]) =>
      sourceDimension(
        "evalComparison",
        key,
        title,
        "Paired immutable case context."
      )
    ),
    sourceTime(
      "evalComparison",
      "createdAt",
      "Pair time",
      "Latest selected target creation time. Both sides must be within the window."
    ),
  ],
  async execute(query, context) {
    const o = query.comparison!,
      project = context.snapshot.projectId
    const window = metricWindow(query, "evalComparison.createdAt")
    const baselineIds = sql.join(
      o.baselineRunIds.map((v) => sql`${v}`),
      sql`, `
    )
    const runIds = sql.join(
      [...o.baselineRunIds, ...o.candidateRunIds].map((v) => sql`${v}`),
      sql`, `
    )
    const time = instantMs(sql`t.created_at`)
    const columns: Record<string, SQL> = {
      datasetId: sql`dataset_id`,
      datasetName: sql`dataset_name`,
      caseId: sql`case_id`,
      status: sql`status`,
      outcome: sql`outcome`,
    }
    const fields = Object.fromEntries(
      Object.entries(columns).map(([key, value]) => [
        "evalComparison." + key,
        { value, type: "string" as const, caseSensitive: true },
      ])
    )
    const facts = sql`with targets as (
      select t.id, coalesce(item.dataset_id,r.dataset_id) as dataset_id, t.dataset_item_id as case_id,
        d.name as dataset_name, ${time} as event_ms, t.run_id in (${baselineIds}) as baseline,
        ${safeJson(sql`t.snapshot_json`)} as snapshot,
        scores.n as score_count, scores.score
      from eval_run_targets t join eval_runs r on r.project_id=${project} and r.id=t.run_id
      left join dataset_items item on item.project_id=${project} and item.id=t.dataset_item_id
      left join datasets d on d.project_id=${project} and d.id=coalesce(item.dataset_id,r.dataset_id)
      left join lateral (select count(*) as n, min(s.value) filter(where s.status='ok' and s.value between 0 and 1) as score
        from eval_results result left join scores s on s.project_id=${project} and s.eval_result_id=result.id and s.name='score'
        where result.project_id=${project} and result.run_id=t.run_id and result.target_id=t.id and result.evaluator_version_id=${o.evaluatorVersionId}) scores on true
      where t.project_id=${project} and t.run_id in (${runIds}) and ${time}>=${window.fromMs} and ${time}<${window.toMs}
    ), cases as (
      select dataset_id,case_id,min(dataset_name) as dataset_name,max(event_ms) as event_ms,
        count(*) filter(where baseline) as bn, count(*) filter(where not baseline) as cn,
        min(score) filter(where baseline) as b, min(score) filter(where not baseline) as c,
        bool_and(score_count=1 and score is not null) as scored,
        count(distinct (snapshot #> '{datasetItem,input}',snapshot #> '{datasetItem,expectedOutput}')) as snapshots,
        bool_and(snapshot #> '{datasetItem,input}' is not null and snapshot #> '{datasetItem,expectedOutput}' is not null) as has_snapshot,
        bool_or(coalesce(snapshot #> '{trace,attributes,synthetic}'='true'::jsonb,false) or coalesce(snapshot #> '{datasetItem,metadata,synthetic}'='true'::jsonb,false)) as synthetic
      from targets group by dataset_id,case_id,case when case_id is null then id end
    ), classified as (
      select *, case when case_id is null or dataset_id is null then 'missingIdentity'
        when bn>1 or cn>1 then 'ambiguous' when bn=0 then 'candidateOnly' when cn=0 then 'baselineOnly'
        when not has_snapshot or snapshots<>1 then 'changedSnapshot' when not scored then 'missingScore' else 'matched' end as status
      from cases
    ), paired as (
      select *, case when status='matched' then c-b end as delta,
        case when status<>'matched' then 'excluded' when c=b then 'unchanged'
          when (c>b) <> ${o.lowerIsBetter ?? false} then 'improved' else 'regressed' end as outcome
      from classified
    ) select b,c,delta,status,synthetic,outcome,
      ${sqlDay(query, "evalComparison.createdAt", sql`event_ms`)} as "evalComparison.createdAt"
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
      from paired where ${semanticSqlFilters(query.filters, fields)}`
    const matched = sql`count(delta)`
    const ci = sql`case when count(delta)>=30 and not bool_or(synthetic) then 1.96*stddev_samp(delta)/sqrt(count(delta)) end`
    const { warnings, ...page } = await aggregateSql(
      query,
      context,
      facts,
      "evalComparison.createdAt",
      {
        caseCount: sql`count(*)`,
        matchedCount: matched,
        excludedCount: sql`count(*)-${matched}`,
        improvedCount: sql`count(*) filter(where outcome='improved')`,
        regressedCount: sql`count(*) filter(where outcome='regressed')`,
        unchangedCount: sql`count(*) filter(where outcome='unchanged')`,
        syntheticCount: sql`count(*) filter(where synthetic)`,
        baselineMean: sql`avg(b) filter(where status='matched')`,
        candidateMean: sql`avg(c) filter(where status='matched')`,
        meanDelta: sql`avg(delta)`,
        deltaCiLow: sql`avg(delta)-${ci}`,
        deltaCiHigh: sql`avg(delta)+${ci}`,
      },
      [],
      {
        excluded: {
          predicate: sql`status<>'matched'`,
          message:
            "cases were excluded from paired scores; group by Pair status to inspect why.",
        },
        synthetic: {
          predicate: sql`synthetic`,
          message:
            "pairs are tagged synthetic; confidence bounds are suppressed for groups containing them.",
        },
      }
    )
    return { ...page, quality: quality(limitations, warnings) }
  },
})

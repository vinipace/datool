import { sql } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  instantMs,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, lifecycleMeasures, sqlDay } from "./aggregate-sql"
import { diagnosticWarnings } from "./quality-sql"
import { metricWindow } from "./common"
import { savedMembershipFields } from "./saved-context"

export async function executeEvalRunsSql(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext
) {
  const window = metricWindow(query, "evalRuns.createdAt"),
    project = context.snapshot.projectId
  const fields: Record<string, SqlFilterField> = {
    ...Object.fromEntries(
      ["id", "name", "status"].map((key) => [
        `evalRuns.${key}`,
        { value: sql`r.${sql.identifier(key)}`, type: "string" as const },
      ])
    ),
    "evalRuns.datasetId": { value: sql`r.dataset_id`, type: "string" },
    "evalRuns.metadata": { value: sql`r.metadata_json`, type: "json" },
    ...savedMembershipFields("evalRuns", project, sql`r.id`),
  }
  const coverage = query.measures.some((m) =>
    [
      "executedCaseCount",
      "completedCaseCount",
      "executionCoverage",
      "completionCoverage",
      "coverageEligibleRunCount",
    ].includes(m.split(".")[1])
  )
  const targets =
    coverage || query.measures.includes("evalRuns.selectedTargetCount")
  const completed = instantMs(sql`r.completed_at`)
  // No joins between targets and results at run grain. Each selected case is counted once.
  const facts = sql`select r.id,r.status,
    case when r.status in ('completed','failed','partial','cancelled') and ${completed}>=r.created_at_ms then ${completed}-r.created_at_ms end as duration,
    ${sqlDay(query, "evalRuns.createdAt", sql`r.created_at_ms`)} as "evalRuns.createdAt"
    ${
      query.dimensions.length
        ? sql`, ${sql.join(
            query.dimensions.map(
              (d) => sql`${fields[d].value} as ${sql.identifier(d)}`
            ),
            sql`, `
          )}`
        : sql``
    },
    ${query.measures.includes("evalRuns.resultCount") ? sql`(select count(*) from eval_results e where e.project_id=${project} and e.run_id=r.id)` : sql`0`} as results,
    ${targets ? sql`selection.selected` : sql`0`} as targets,
    ${coverage ? sql`selection.executed` : sql`null::bigint`} as executed,
    ${coverage ? sql`selection.completed` : sql`null::bigint`} as completed,
    ${
      coverage
        ? sql`(selection.selected>0 and exists(select 1 from eval_run_evaluators expected where expected.project_id=${project} and expected.run_id=r.id)
      and not exists(select 1 from eval_results e where e.project_id=${project} and e.run_id=r.id and (e.target_id is null or not exists(select 1 from eval_run_evaluators expected where expected.project_id=${project} and expected.run_id=r.id and expected.evaluator_id=e.evaluator_id and expected.evaluator_version_id=e.evaluator_version_id))))`
        : sql`false`
    } as eligible
    from eval_runs r
    ${
      targets
        ? sql`left join lateral (select count(*) as selected,
      ${coverage ? sql`count(*) filter(where exists(select 1 from eval_results e where e.project_id=${project} and e.run_id=r.id and e.target_id=t.id))` : sql`null::bigint`} as executed,
      ${coverage ? sql`count(*) filter(where not exists(select 1 from eval_run_evaluators expected where expected.project_id=${project} and expected.run_id=r.id and not exists(select 1 from eval_results e where e.project_id=${project} and e.run_id=r.id and e.target_id=t.id and e.evaluator_id=expected.evaluator_id and e.evaluator_version_id=expected.evaluator_version_id and e.status in ('completed','passed','failed','error'))))` : sql`null::bigint`} as completed
      from eval_run_targets t where t.project_id=${project} and t.run_id=r.id) selection on true`
        : sql``
    }
    where r.project_id=${project} and r.created_at_ms>=${window.fromMs} and r.created_at_ms<${window.toMs} and ${semanticSqlFilters(query.filters, fields)}`
  const page = await aggregateSql(
    query,
    context,
    facts,
    "evalRuns.createdAt",
    {
      count: sql`count(*)`,
      ...lifecycleMeasures([
        "completed",
        "failed",
        "partial",
        "running",
        "cancelled",
      ]),
      resultCount: sql`coalesce(sum(results),0)`,
      selectedTargetCount: sql`coalesce(sum(targets),0)`,
      selectedUniqueTraceCount: sql`(select count(distinct t.trace_id) from eval_run_targets t where t.project_id=${project} and t.run_id=any(array_agg(facts.id)))`,
      durationSampleCount: sql`count(duration)`,
      meanDurationMs: sql`avg(duration)`,
      p95DurationMs: sql`percentile_disc(0.95) within group(order by duration)`,
      coverageEligibleRunCount: sql`count(*) filter(where eligible)`,
      executedCaseCount: sql`sum(executed) filter(where eligible)`,
      completedCaseCount: sql`sum(completed) filter(where eligible)`,
      executionCoverage: sql`sum(executed) filter(where eligible)::double precision/nullif(sum(targets) filter(where eligible),0)`,
      completionCoverage: sql`sum(completed) filter(where eligible)::double precision/nullif(sum(targets) filter(where eligible),0)`,
    },
    [],
    coverage
      ? {
          coverage: {
            predicate: sql`not eligible`,
            message:
              "run(s) lack sufficient frozen target/scorer linkage and are excluded from coverage metrics.",
          },
        }
      : {}
  )
  const invalid = await diagnosticWarnings(
    context,
    sql`select r.created_at_ms as time,r.status from eval_runs r where r.project_id=${project} and (r.created_at_ms is null or (r.created_at_ms>=${window.fromMs} and r.created_at_ms<${window.toMs})) and ${semanticSqlFilters(query.filters, fields)}`,
    {
      time: {
        predicate: sql`time is null`,
        message:
          "persisted eval-run row(s) had an invalid createdAt and were excluded.",
      },
      status: {
        predicate: sql`time is not null and status not in ('completed','failed','partial','running','cancelled')`,
        message:
          "eval-run row(s) used an unrecognized persisted lifecycle status.",
      },
    }
  )
  return { ...page, warnings: [...page.warnings, ...invalid] }
}

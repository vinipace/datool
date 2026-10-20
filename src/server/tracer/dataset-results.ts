import { sql } from "drizzle-orm"
import type {
  DatasetEvaluation,
  DatasetEvaluationSummary,
} from "@/src/lib/tracer/contracts"
import { getTracerProjectId, type TracerDatabase } from "./db"

function latestResultsSource(
  project: string,
  datasetId: string,
  agentId: string | null,
  itemIds?: string[]
) {
  return sql`
    select i.id as "itemId", latest.*, judgments.score,
      case
        when latest."targetId" is null then 'not-run'
        when latest.status='cancelled' then 'cancelled'
        when latest.status in ('error','blocked') or judgments.errors>0 then 'failed'
        when latest.status<>'completed' then 'pending'
        when judgments.failed>0 then 'failed'
        when judgments.total>0 and judgments.passed=judgments.total
          and judgments.total=(select count(*) from eval_run_evaluators re
            where re.project_id=${project} and re.run_id=latest."runId") then 'passed'
        else 'unscored'
      end as outcome
    from dataset_items i
    left join lateral (
      select t.id as "targetId", t.trace_id as "traceId", r.id as "runId",
        r.created_at as "createdAt",
        case when r.status='cancelled' then 'cancelled' else t.stage end as status,
        left(case when jsonb_typeof(t.snapshot_json::jsonb #> '{trace,output}')='string'
          then t.snapshot_json::jsonb #>> '{trace,output}'
          else nullif((t.snapshot_json::jsonb #> '{trace,output}')::text, 'null') end, 500) as output,
        left(coalesce(t.execution_error, t.snapshot_json::jsonb #>> '{trace,attributes,error.message}'), 1000) as error
      from eval_run_targets t
      join eval_runs r on r.project_id=t.project_id and r.id=t.run_id
      where t.project_id=${project} and r.dataset_id=${datasetId}
        and r.agent_id is not distinct from ${agentId}
        and (t.dataset_item_id=i.id or
          (t.dataset_item_id is null and t.snapshot_json::jsonb #>> '{datasetItem,id}'=i.id))
      order by r.created_at desc, r.id desc, t.ordinal
      limit 1
    ) latest on true
    left join lateral (
      select avg(e.score) as score, count(*) as total,
        count(*) filter(where e.passed=true) as passed,
        count(*) filter(where e.passed=false) as failed,
        count(*) filter(where e.error is not null) as errors
      from eval_results e where e.project_id=${project}
        and e.run_id=latest."runId" and e.target_id=latest."targetId"
    ) judgments on true
    where i.project_id=${project} and i.dataset_id=${datasetId}
      ${
        itemIds
          ? itemIds.length
            ? sql`and i.id in (${sql.join(
                itemIds.map((id) => sql`${id}`),
                sql`, `
              )})`
            : sql`and false`
          : sql``
      }
  `
}

/** Row previews are bounded; the rate always covers the entire dataset. */
export async function latestDatasetResults(
  database: TracerDatabase,
  datasetId: string,
  agentId: string | null,
  itemIds: string[]
) {
  const project = getTracerProjectId(database)
  const result = await database.execute<DatasetEvaluation & { itemId: string }>(
    sql`select * from (${latestResultsSource(project, datasetId, agentId, itemIds)}) rows where "targetId" is not null`
  )
  const counts = await database.execute<
    Omit<DatasetEvaluationSummary, "successRate">
  >(sql`
    select count(*)::integer as total,
      count(*) filter(where outcome='passed')::integer as passed,
      count(*) filter(where outcome='failed')::integer as failed,
      count(*) filter(where outcome='pending')::integer as pending,
      count(*) filter(where outcome='unscored')::integer as unscored,
      count(*) filter(where outcome='cancelled')::integer as cancelled,
      count(*) filter(where outcome='not-run')::integer as "notRun"
    from (${latestResultsSource(project, datasetId, agentId)}) rows
  `)
  const summary = counts.rows[0]
  return {
    items: new Map(result.rows.map(({ itemId, ...value }) => [itemId, value])),
    summary: {
      ...summary,
      successRate:
        summary.passed + summary.failed
          ? summary.passed / (summary.passed + summary.failed)
          : null,
    },
  }
}

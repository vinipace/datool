import { sql } from "drizzle-orm"
import type {
  EvalScorerProgress,
  ScorerExecutionStatus,
} from "@/src/lib/tracer/contracts"
import type { TracerDatabase } from "./db"

/** All-target progress comes from persisted attempts, independent of table pagination. */
export async function getEvalProgress(
  database: TracerDatabase,
  projectId: string,
  runId: string,
  pageTargetIds: string[]
) {
  const result = await database.execute(sql`
    with targets as materialized (
      select id, trace_id, dataset_item_id from eval_run_targets
      where project_id=${projectId} and run_id=${runId}
    ), attempts as materialized (
      select distinct on (s.attributes_json::jsonb->>'eval.target_id', s.attributes_json::jsonb->>'scorer.id')
        s.attributes_json::jsonb->>'eval.target_id' as target_id,
        s.attributes_json::jsonb->>'scorer.id' as evaluator_id,
        s.status, s.attributes_json::jsonb->>'scorer.skipped' = 'true' as skipped
      from spans s
      where s.project_id=${projectId} and s.kind='score'
        and s.trace_id in (select trace_id from targets)
        and s.attributes_json::jsonb->>'eval.run_id'=${runId}
        and s.attributes_json::jsonb->>'datool.scorer.execution'='true'
      order by s.attributes_json::jsonb->>'eval.target_id', s.attributes_json::jsonb->>'scorer.id', s.started_at desc, s.id desc
    ), results as materialized (
      select distinct on (t.id, r.evaluator_id) t.id as target_id, r.evaluator_id, r.status, r.score,
        r.metadata_json::jsonb->>'skipped'='true' as skipped
      from eval_results r join targets t on
        r.metadata_json::jsonb->>'evalTargetId'=t.id or
        (not (r.metadata_json::jsonb ? 'evalTargetId') and r.trace_id=t.trace_id and r.dataset_item_id is not distinct from t.dataset_item_id)
      where r.project_id=${projectId} and r.run_id=${runId}
      order by t.id, r.evaluator_id, r.completed_at desc, r.id desc
    ), cells as materialized (
      select t.id as target_id, e.evaluator_id,
        coalesce(v.config_json::jsonb->>'name', catalog.name) as name, v.version, r.score,
        case
          when r.skipped or a.skipped then 'skipped'
          when r.status is not null then case when r.status='error' then 'error' else 'completed' end
          when run.status='running' then case when a.target_id is null then 'queued' else 'running' end
          when a.target_id is not null then 'error'
          else 'skipped'
        end as status
      from eval_run_evaluators e
      join eval_runs run on run.project_id=e.project_id and run.id=e.run_id
      join evaluators catalog on catalog.project_id=e.project_id and catalog.id=e.evaluator_id
      join evaluator_versions v on v.project_id=e.project_id and v.id=e.evaluator_version_id
      cross join targets t
      left join results r on r.target_id=t.id and r.evaluator_id=e.evaluator_id
      left join attempts a on a.target_id=t.id and a.evaluator_id=e.evaluator_id
      where e.project_id=${projectId} and e.run_id=${runId}
    ), progress as (
      select evaluator_id as "evaluatorId", name, version, count(*)::integer as total, avg(score) as score,
        count(*) filter(where status='queued')::integer as queued,
        count(*) filter(where status='running')::integer as running,
        count(*) filter(where status='completed')::integer as completed,
        count(*) filter(where status='error')::integer as error,
        count(*) filter(where status='skipped')::integer as skipped
      from cells group by evaluator_id, name, version
    ), page as (
      select target_id, jsonb_object_agg(evaluator_id, status) as statuses from cells
      where ${
        pageTargetIds.length
          ? sql`target_id in (${sql.join(
              pageTargetIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          : sql`false`
      }
      group by target_id
    )
    select coalesce((select jsonb_agg(to_jsonb(progress) order by name, "evaluatorId") from progress), '[]'::jsonb) as scorers,
      coalesce((select jsonb_object_agg(target_id, statuses) from page), '{}'::jsonb) as targets
  `)
  return result.rows[0] as {
    scorers: EvalScorerProgress[]
    targets: Record<string, Record<string, ScorerExecutionStatus>>
  }
}

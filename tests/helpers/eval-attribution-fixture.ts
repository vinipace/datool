import { sql } from "drizzle-orm"
import {
  getTracerProjectId,
  type TracerDatabase,
} from "../../src/server/tracer/db"
import { TracerService } from "../../src/server/tracer/service"
import { runTracerEffect as run } from "../../src/server/tracer/effect"
import { defaultScorer } from "../../src/lib/tracer/scorers"

/** Synthetic persisted facts in an already isolated test database; no model calls. */
export async function seedEvalAttributionFacts(
  db: TracerDatabase,
  runCount: number,
  targetsPerRun = 5
) {
  const project = getTracerProjectId(db)
  const service = new TracerService(db)
  const scorer = await run(
    service.scorers.save({
      ...defaultScorer,
      name: "Fixture quality",
      slug: "fixture-quality",
      type: "javascript",
      code: "function evaluate() { return {score:1}; }",
    })
  )
  const trace = await run(
    service.createTrace({
      name: "Fixture",
      operation: "workflow",
      input: {},
      output: {},
      status: "completed",
    })
  )
  const now = new Date()
  const timestamp = now.toISOString()
  await db.execute(sql`insert into eval_runs(id,project_id,name,status,created_at,completed_at,groups_resolved_at)
    select 'run-' || i,${project},'Run ' || i,'completed',to_char(${timestamp}::timestamptz - ((${runCount}-i)*interval '1 minute'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),${timestamp},${timestamp} from generate_series(1,${runCount}) i`)
  await db.execute(sql`insert into eval_run_targets(id,project_id,run_id,trace_id,ordinal,created_at)
    select 'target-' || i || '-' || j,${project},'run-' || i,${trace.id},j,${timestamp} from generate_series(1,${runCount}) i cross join generate_series(1,${targetsPerRun}) j`)
  await db.execute(sql`insert into eval_run_groups(id,project_id,run_id,group_type,group_name)
    select 'group-' || i || '-' || type,${project},'run-' || i,type,case when type='workflow' then case when i=1 then 'Rare workflow' else 'Workflow ' || (i%8) end else 'Agent ' || (i%4) end
    from generate_series(1,${runCount}) i cross join (values ('workflow'),('agent')) t(type)`)
  await db.execute(sql`insert into eval_target_attributions(id,project_id,run_id,target_id,group_type,group_name,models_json,source_trace_id)
    select t.id || '-' || g.group_type,${project},t.run_id,t.id,g.group_type,g.group_name,jsonb_build_array('Model ' || (t.ordinal%3)),${trace.id}
    from eval_run_targets t join eval_run_groups g on g.project_id=t.project_id and g.run_id=t.run_id where t.project_id=${project}`)
  await db.execute(sql`insert into eval_results(id,project_id,run_id,target_id,trace_id,evaluator_id,evaluator_version_id,score,status,created_at,completed_at)
    select 'result-' || t.id,${project},t.run_id,t.id,${trace.id},${scorer.id},(select active_version_id from evaluators where id=${scorer.id} and project_id=${project}),(t.ordinal%11)::float/10,'completed',r.created_at,r.created_at
    from eval_run_targets t join eval_runs r on r.project_id=t.project_id and r.id=t.run_id where t.project_id=${project}`)
  await db.execute(sql`insert into scores(id,project_id,trace_id,eval_result_id,evaluator_id,name,value,status,created_at)
    select 'score-' || id,${project},trace_id,id,evaluator_id,'score',score,'ok',created_at from eval_results where project_id=${project}`)
  return { project, scorer, trace, now }
}

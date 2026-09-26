import { Pool, type PoolClient } from "pg"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "../../tests/helpers/postgres"
import { serveWebhook } from "../../src/server/apps/webhook"
import { localEndpoint } from "./safety"

/** Synthetic local data and the real authenticated route handlers; never the operator's database. */
export async function collectionRefreshFixture() {
  localEndpoint(process.env.DATOOL_TEST_REDIS_URL ?? "", ["redis:"])
  const target = await createIsolatedPostgres()
  const seed = new Pool({ connectionString: target.databaseUrl })
  let server: Awaited<ReturnType<typeof serveWebhook>> | undefined
  let pools: typeof import("../../lib/db") | undefined
  const counters = { sql: 0, dataSql: 0, revisionSql: 0 }
  let counting = false
  const close = async () => {
    counting = false
    server?.stop()
    const { routeCacheRedis } = await import("../../src/server/cache/redis")
    await routeCacheRedis()?.quit()
    await pools?.db.end(); await pools?.analyticsDb.end()
    await seed.end(); await target.close()
  }
  try {
    await migrateIsolatedPostgres(target); await seedTestWorkspace(target)
    const p = target.projectId
    await seed.query(`INSERT INTO sessions(id,project_id,name,created_at,updated_at)
      SELECT 'session-'||i,$1,'Session '||i,now(),now() FROM generate_series(1,100)i`, [p])
    await seed.query(`INSERT INTO traces(id,project_id,session_id,name,operation,status,started_at,ended_at,input_json,output_json)
      SELECT 'trace-'||i,$1,'session-'||((i-1)/20+1),'Trace '||i,'comparison','completed',
      to_char(now() - (i * interval '1 second'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),jsonb_build_object('case',i)::text,
      jsonb_build_object('answer',repeat('x',512))::text FROM generate_series(1,2000)i`, [p])
    await seed.query(`INSERT INTO spans(id,project_id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
      SELECT 'span-'||i||'-'||s,$1,'trace-'||i,'Model','llm','completed',now(),now(),
      '{"cost.usd":0.01,"usage.input_tokens":100}' FROM generate_series(1,2000)i CROSS JOIN generate_series(1,5)s`, [p])
    await seed.query(`INSERT INTO evaluators(id,project_id,name,created_at,updated_at) VALUES('scorer',$1,'Quality',now(),now())`, [p])
    await seed.query(`INSERT INTO evaluator_versions(id,project_id,evaluator_id,version,language,code,created_at)
      VALUES('scorer-v1',$1,'scorer',1,'javascript','return 1',now())`, [p])
    await seed.query(`INSERT INTO eval_runs(id,project_id,name,status,created_at,groups_resolved_at)
      SELECT 'run-'||i,$1,'Run '||i,'running',now(),now() FROM generate_series(1,50)i`, [p])
    await seed.query(`INSERT INTO eval_run_groups(id,project_id,run_id,group_type,group_name,group_version)
      SELECT 'group-'||i,$1,'run-'||i,'workflow','Workflow '||(i%5),'1' FROM generate_series(1,50)i`, [p])
    await seed.query(`INSERT INTO eval_run_evaluators(id,project_id,run_id,evaluator_id,evaluator_version_id)
      SELECT 'evaluator-'||i,$1,'run-'||i,'scorer','scorer-v1' FROM generate_series(1,50)i`, [p])
    await seed.query(`INSERT INTO eval_run_targets(id,project_id,run_id,trace_id,ordinal,created_at,snapshot_json)
      SELECT 'target-'||r||'-'||i,$1,'run-'||r,'trace-'||i,i,now(),
      jsonb_build_object('trace',jsonb_build_object('id','trace-'||i,'name','Trace '||i,'operation','comparison',
      'status','completed','startedAt',t.started_at,'endedAt',t.ended_at,'sessionId',t.session_id,
      'input',t.input_json::jsonb,'output',t.output_json::jsonb,'attributes','{}'::jsonb,'spans','[]'::jsonb),
      'datasetItem',null)::text FROM generate_series(1,50)r CROSS JOIN generate_series(1,200)i
      JOIN traces t ON t.project_id=$1 AND t.id='trace-'||i`, [p])
    await seed.query(`INSERT INTO eval_results(id,project_id,run_id,target_id,trace_id,evaluator_id,evaluator_version_id,score,status,metadata_json,created_at,completed_at)
      SELECT 'result-'||r||'-'||i,$1,'run-'||r,'target-'||r||'-'||i,'trace-'||i,'scorer','scorer-v1',1,'completed',
      jsonb_build_object('evalTargetId','target-'||r||'-'||i)::text,now(),now()
      FROM generate_series(1,50)r CROSS JOIN generate_series(1,100)i`, [p])
    for (const table of ['sessions','traces','spans','eval_runs','eval_run_targets','eval_results','eval_run_groups','trace_read_revisions']) {
      await seed.query(`VACUUM (ANALYZE) ${table}`)
    }
    Object.assign(process.env, { DATABASE_URL: target.databaseUrl, REDIS_URL: process.env.DATOOL_TEST_REDIS_URL,
      BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: `collection-test-${crypto.randomUUID()}`, DATOOL_BILLING_ENABLED: "false" })
    const { getAuth } = await import("../../lib/auth")
    pools = await import("../../lib/db")
    const instrument = (client: PoolClient) => {
      const original = client.query
      client.query = function(...args: unknown[]) {
        const first = args[0] as string | { text?: string }
        const sql = typeof first === "string" ? first : first.text ?? ""
        if (counting) {
          counters.sql++
          if (/^\s*(select|with)\b/i.test(sql) && /\b(sessions|traces|spans|scores|review_scores|eval_runs|eval_results|eval_run_targets|eval_run_groups)\b/i.test(sql)) counters.dataSql++
          if (/FROM trace_read_revisions WHERE project_id/.test(sql)) counters.revisionSql++
        }
        return (original as (...args: unknown[]) => unknown).apply(client, args)
      } as typeof client.query
    }
    pools.db.on("connect", instrument); pools.analyticsDb.on("connect", instrument)
    const credential = await getAuth().api.createApiKey({ body: { organizationId: target.organizationId, userId: target.ownerId,
      name: "Disposable collection comparison", permissions: { traces: ["read","write"], evals: ["read","write"] },
      rateLimitMax: 1_000_000, rateLimitTimeWindow: 60_000 } })
    const { refreshRoutes } = await import("./refresh-routes")
    const route = await refreshRoutes()
    server = await serveWebhook(route)
    const { routeCacheRedis } = await import("../../src/server/cache/redis")
    const redis = routeCacheRedis()!
    if (redis.status !== "ready") await new Promise<void>((resolve, reject) => {
      redis.once("ready", resolve); redis.once("error", reject)
    })
    return { target, seed, route, origin: `http://127.0.0.1:${server.port}`, redis,
      headers: { authorization: `Bearer ${credential.key}`, "x-project-id": target.projectId },
      startCount() { Object.assign(counters, { sql: 0, dataSql: 0, revisionSql: 0 }); counting = true },
      stopCount() { counting = false; return { ...counters } }, close }
  } catch (error) { await close(); throw error }
}

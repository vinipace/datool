/** Qualify the rating backfill on disposable local data, including blocked writers. */
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { seedEvalAttributionFacts } from "../tests/helpers/eval-attribution-fixture"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"

const target = await createIsolatedPostgres()
const pool = new Pool({ connectionString: target.databaseUrl, max: 6 })
const db = createTracerDatabase(target.databaseUrl, {
  projectId: target.projectId,
})
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  nativeRatings: 50000,
  reviewRatings: 50000,
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timed = async (operation: () => Promise<unknown>) => {
  const start = performance.now()
  await operation()
  return Math.round(performance.now() - start)
}
try {
  for (const file of (await readdir("migrations"))
    .filter((file) => file.endsWith(".sql") && file < "0040")
    .sort())
    await pool.query(await readFile(`migrations/${file}`, "utf8"))
  await seedTestWorkspace(target)
  const { project, trace, now } = await seedEvalAttributionFacts(db, 10000)
  const timestamp = now.toISOString()
  await pool.query(
    `insert into human_scores(id,project_id,name,config_json,created_at,updated_at)
    values ('human', $1, 'Quality', '{"type":"numeric","min":0,"max":1}', $2, $2)`,
    [project, timestamp]
  )
  await pool.query(
    `insert into review_sessions(id,project_id,name,created_at,updated_at)
    values ('session', $1, 'Review', $2, $2)`,
    [project, timestamp]
  )
  await pool.query(
    `insert into review_items(id,project_id,session_id,trace_id,ordinal)
    values ('item', $1, 'session', $2, 0)`,
    [project, trace.id]
  )
  // Criterion cardinality is synthetic; the backfill only depends on row count and timestamps.
  await pool.query(
    `insert into review_scores(id,project_id,item_id,trace_id,criterion_key,name,value,source,updated_at,human_score_id,definition_json,human_value)
    select 'review-'||i,$1,'item',$2,'criterion-'||i,'Quality',0.5,'human',$3,'human','{"type":"numeric"}','0.5'
    from generate_series(1,50000)i`,
    [project, trace.id, timestamp]
  )
  await pool.query("analyze scores; analyze review_scores")
  const migration = await pool.connect()
  try {
    await migration.query("BEGIN")
    const pid = (await migration.query("select pg_backend_pid() as pid"))
      .rows[0].pid
    let finished = false
    const applying = timed(async () => {
      await migration.query(
        await readFile("migrations/0040_score_analytics_instants.sql", "utf8")
      )
      await migration.query("COMMIT")
    }).finally(() => {
      finished = true
    })
    // Observe the real migration lock before offering concurrent writes.
    let sawLock = false
    while (!finished) {
      const locks = await pool.query(
        "select 1 from pg_locks where pid=$1 and mode='AccessExclusiveLock' and granted",
        [pid]
      )
      if (locks.rowCount) {
        sawLock = true
        break
      }
      await sleep(5)
    }
    const results = await Promise.allSettled([
      applying,
      timed(() =>
        pool.query(
          "update scores set value=0.7 where project_id=$1 and id='score-result-target-1-1'",
          [project]
        )
      ),
      timed(() =>
        pool.query(
          "update review_scores set human_value='0.7' where project_id=$1 and id='review-1'",
          [project]
        )
      ),
      timed(() =>
        pool.query(
          "insert into traces(id,project_id,name,operation,status,started_at) values ('during-migration',$1,'Concurrent ingestion','fixture','completed',$2)",
          [project, timestamp]
        )
      ),
    ])
    for (const result of results)
      if (result.status === "rejected") throw result.reason
    const [migrationMs, ...probes] = results.map(
      (result) => (result as PromiseFulfilledResult<number>).value
    )
    report.migrationMs = migrationMs
    report.sawAccessExclusiveLock = sawLock
    assert(sawLock)
    report.concurrentWritesMs = {
      nativeRating: probes[0],
      reviewRating: probes[1],
      traceIngestion: probes[2],
    }
  } catch (error) {
    await migration.query("ROLLBACK")
    throw error
  } finally {
    migration.release()
  }
  for (const table of ["scores", "review_scores"]) {
    const column = table === "scores" ? "created_at" : "updated_at"
    const result = (
      await pool.query(
        `select count(*)::int as count, count(*) filter(where event_at_ms is distinct from datool_timestamp_ms(${column}))::int as mismatches from ${table}`
      )
    ).rows[0]
    assert.deepEqual(result, { count: 50000, mismatches: 0 })
    await pool.query(
      `update ${table} set ${column}='2026-09-23T00:00:00Z' where id=$1`,
      [table === "scores" ? "score-result-target-1-1" : "review-1"]
    )
    assert.equal(
      (
        await pool.query(`select event_at_ms from ${table} where id=$1`, [
          table === "scores" ? "score-result-target-1-1" : "review-1",
        ])
      ).rows[0].event_at_ms,
      Date.parse("2026-09-23T00:00:00Z")
    )
  }
  report.correctness =
    "100000 historical timestamps and subsequent updates verified"
  report.status = "passed"
} catch (error) {
  report.status = "failed"
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await closeTracerDatabase(db)
  await pool.end()
  await target.close()
  report.fixtureRemoved = true
  await mkdir(".tmp", { recursive: true })
  await writeFile(
    ".tmp/dashboard-migration-performance.json",
    JSON.stringify(report, null, 2) + "\n"
  )
  console.info(JSON.stringify(report))
}

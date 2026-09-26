import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readdir, readFile } from "node:fs/promises"
import assert from "node:assert/strict"
import { afterEach, describe, expect, test } from "bun:test"

import { Pool } from "pg"

import {
  createIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

const tracerTables = [
  "sessions",
  "traces",
  "spans",
  "datasets",
  "dataset_items",
  "evaluators",
  "evaluator_versions",
  "eval_runs",
  "eval_run_evaluators",
  "eval_run_targets",
  "eval_results",
  "scores",
  "score_imports",
  "langfuse_import_runs",
  "langfuse_import_records",
  "langfuse_import_pages",
  "langfuse_import_entities",
  "saved_views",
  "dataset_snapshots",
  "dataset_snapshot_items",
  "app_bridge_exchange",
  "agent_eval_requests",
]

describe("PostgreSQL migrations", () => {
  let target: IsolatedPostgres | undefined

  afterEach(async () => {
    await target?.close()
    target = undefined
  })

  test("rating migration aborts on lock contention without leaving a partial schema", async () => {
    target = await createIsolatedPostgres()
    const pool = new Pool({ connectionString: target.databaseUrl })
    const blocker = await pool.connect()
    const migration = await pool.connect()
    try {
      for (const file of (await readdir("migrations"))
        .filter((file) => file.endsWith(".sql") && file < "0040")
        .sort())
        await migration.query(await readFile(`migrations/${file}`, "utf8"))
      await blocker.query("BEGIN; LOCK TABLE scores IN ACCESS SHARE MODE")
      await migration.query("BEGIN")
      const sql = await readFile(
        "migrations/0040_score_analytics_instants.sql",
        "utf8"
      )
      await assert.rejects(migration.query(sql), { code: "55P03" })
      await migration.query("ROLLBACK")
      expect(
        (
          await migration.query(
            "select column_name from information_schema.columns where table_schema=$1 and table_name='scores' and column_name='event_at_ms'",
            [target.schema]
          )
        ).rows
      ).toEqual([])
      await blocker.query("ROLLBACK")
      await migration.query("BEGIN")
      await migration.query(sql)
      await migration.query("COMMIT")
      expect(
        (await migration.query("select event_at_ms from scores")).rows
      ).toEqual([])
    } finally {
      await blocker.query("ROLLBACK")
      await migration.query("ROLLBACK")
      blocker.release()
      migration.release()
      await pool.end()
    }
  }, 10000)

  test("an already applied text-attribute baseline advances to JSONB without reclassifying history", async () => {
    target = await createIsolatedPostgres()
    const pool = new Pool({ connectionString: target.databaseUrl })
    try {
      const baseline = await readFile("migrations/0001_initial.sql", "utf8")
      await pool.query(
        baseline.replaceAll("attributes_json jsonb", "attributes_json text")
      )
      await pool.query(
        "create table schema_migration(name text primary key, applied_at timestamptz not null default now())"
      )
      await pool.query(
        "insert into schema_migration(name) values('0001_initial.sql')"
      )
      await seedTestWorkspace(target)
      await pool.query(
        `insert into traces(project_id,id,name,operation,status,started_at,ended_at,attributes_json)
        values($1,'existing','Existing','test','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','{"agent.name":"Old metadata","cost.usd":1.25}')`,
        [target.projectId]
      )
      await pool.query(
        `insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
        values($1,'existing-span','existing','Model','llm','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','{"cost.usd":0.5}')`,
        [target.projectId]
      )
      // Seed a real pre-import score graph before upgrading the old schema.
      await pool.query(
        `insert into evaluators(id,project_id,name,created_at,updated_at)
        values('old-evaluator',$1,'Quality','2026-09-01','2026-09-01')`,
        [target.projectId]
      )
      await pool.query(
        `insert into evaluator_versions(id,project_id,evaluator_id,version,language,code,created_at)
        values('old-version',$1,'old-evaluator',1,'javascript','function evaluate() { return { score: 0.8 } }','2026-09-01')`,
        [target.projectId]
      )
      await pool.query(
        `insert into eval_runs(id,project_id,status,created_at)
        values('old-run',$1,'completed','2026-09-01')`,
        [target.projectId]
      )
      await pool.query(
        `insert into eval_results(id,project_id,run_id,trace_id,evaluator_id,evaluator_version_id,score,status,created_at)
        values('old-result',$1,'old-run','existing','old-evaluator','old-version',0.8,'completed','2026-09-01')`,
        [target.projectId]
      )
      await pool.query(
        `insert into scores(id,project_id,trace_id,eval_result_id,evaluator_id,name,value,status,created_at)
        values('old-score',$1,'existing','old-result','old-evaluator','score',0.8,'ok','2026-09-01')`,
        [target.projectId]
      )
      const oldScore = (
        await pool.query("select * from scores where id='old-score'")
      ).rows[0]
      for (let i = 0; i < 2; i++) {
        await promisify(execFile)(
          process.execPath,
          ["run", "scripts/migrate.ts"],
          {
            env: { ...process.env, DATABASE_URL: target.databaseUrl },
            timeout: 5000,
          }
        )
      }
      const migratedScore = (
        await pool.query("select * from scores where id='old-score'")
      ).rows[0]
      expect(migratedScore).toEqual({
        ...oldScore,
        external_json: null,
        import_id: null,
        span_id: null,
        session_id: null,
        eval_run_id: null,
        event_at_ms: Date.parse(oldScore.created_at),
      })
      const traces = await pool.query(
        "select pg_typeof(attributes_json)::text as type,attributes_json,cost_usd,duration_ms,group_type from traces"
      )
      expect(traces.rows).toEqual([
        {
          type: "jsonb",
          attributes_json: { "agent.name": "Old metadata", "cost.usd": 1.25 },
          cost_usd: 1.25,
          duration_ms: 1000,
          group_type: null,
        },
      ])
      const spans = await pool.query(
        "select pg_typeof(attributes_json)::text as type,cost_usd from spans"
      )
      expect(spans.rows).toEqual([{ type: "jsonb", cost_usd: 0.5 }])
      const memberships = await pool.query(
        "select count(*) as count from trace_group_memberships"
      )
      expect(memberships.rows[0].count).toBe("0")
      await pool.query(
        `insert into traces(project_id,id,name,operation,status,started_at,group_type,group_name)
        values($1,'new','New','test','running','2026-09-01T00:00:00Z','agent','New group')`,
        [target.projectId]
      )
      const fresh = await pool.query(
        "select attributes_json from traces where id='new'"
      )
      expect(fresh.rows[0].attributes_json).toEqual({})
      const summary = await pool.query(
        "select row_count from invocation_hourly_stats"
      )
      expect(summary.rows[0].row_count).toBe("1")
    } finally {
      await pool.end()
    }
  }, 15_000)

  test("the migration runner records applied files and safely runs twice", async () => {
    target = await createIsolatedPostgres()
    // Exercise the deployed runner's migration ledger. Replaying every raw DDL
    // file bypasses that ledger; 0001 contains a non-repeatable consent trigger.
    const migrate = () =>
      promisify(execFile)(process.execPath, ["run", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: target!.databaseUrl },
        timeout: 5000,
      })
    await migrate()
    await migrate()
    await seedTestWorkspace(target)

    const pool = new Pool({ connectionString: target.databaseUrl })
    try {
      const applied = await pool.query(
        "select name from schema_migration order by name"
      )
      // Cover every migration without maintaining a second, stale file list.
      const migrationFiles = (await readdir("migrations"))
        .filter((file) => file.endsWith(".sql"))
        .sort()
      expect(applied.rows.map((row) => row.name)).toEqual(migrationFiles)
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [target.schema]
      )
      const names = new Set(tables.rows.map((row) => row.table_name))
      for (const table of [
        "user",
        "organization",
        "member",
        "project",
        ...tracerTables,
      ]) {
        expect(names.has(table)).toBe(true)
      }

      const workspace = await pool.query<{
        organizations: string
        projects: string
        members: string
      }>(
        `SELECT
           (SELECT count(*) FROM organization)::text AS organizations,
           (SELECT count(*) FROM project)::text AS projects,
           (SELECT count(*) FROM member)::text AS members`
      )
      expect(workspace.rows[0]).toEqual({
        organizations: "1",
        projects: "1",
        members: "1",
      })
    } finally {
      await pool.end()
    }
  })
})

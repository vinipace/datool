import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

test("the forward read migration replays and normalizes raw timestamps without inferring groups", async () => {
  const target = await createIsolatedPostgres(),
    pool = new Pool({ connectionString: target.databaseUrl })
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const migration = await readFile(
      "migrations/0002_bounded_reads.sql",
      "utf8"
    )
    await pool.query(migration)
    await pool.query(migration)
    await pool.query(
      `insert into traces(project_id,id,name,operation,status,started_at,attributes_json) values($1,'old','Legacy','agent','completed','2026-09-01T00:00:00Z','{"agent.name":"legacy"}')`,
      [target.projectId]
    )
    expect(
      (
        await pool.query(
          "select group_type,group_name,group_version from traces where id='old'"
        )
      ).rows[0]
    ).toEqual({ group_type: null, group_name: null, group_version: null })
    await pool.query(
      `insert into eval_runs(project_id,id,status,created_at) values($1,'offset','completed','2026-09-01T02:00:00+02:00'),($1,'invalid','completed','invalid')`,
      [target.projectId]
    )
    const rows = (
      await pool.query("select id,created_at_ms from eval_runs order by id")
    ).rows
    expect(rows).toEqual([
      { id: "invalid", created_at_ms: null },
      { id: "offset", created_at_ms: Date.parse("2026-09-01T00:00:00Z") },
    ])
  } finally {
    await pool.end()
    await target.close()
  }
})

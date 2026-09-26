import { afterEach, expect, test } from "bun:test"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"
import { createTestTracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"

let target: IsolatedPostgres | undefined
let pool: Pool | undefined
afterEach(async () => {
  await pool?.end()
  await target?.close()
})
async function expectInvalidCursor(operation: Promise<unknown>) {
  let message = ""
  try {
    await operation
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toContain("cursor does not identify")
}
async function fixture() {
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  pool = new Pool({ connectionString: target.databaseUrl })
  return { target, pool }
}

test("trace SQL pages preserve ties, totals, filtered cursor validation and tenant boundaries", async () => {
  const { target, pool } = await fixture()
  await pool.query(
    `INSERT INTO traces (id, project_id, name, operation, status, started_at)
    SELECT id, $1, id, operation, 'completed', '2026-09-09T00:00:00Z'
    FROM (VALUES ('a','chat'), ('b','chat'), ('c','chat'), ('d','other')) AS x(id, operation)`,
    [target.projectId]
  )
  const service = await createTestTracerService(
    target.databaseUrl,
    target.projectId
  )
  const first = await runTracerEffect(
    service.listTraces({ includeTotal: true, limit: 2 })
  )
  expect(first.items.map((x) => x.id)).toEqual(["d", "c"])
  expect(first.total).toBe(4)
  expect(first.nextCursor).toBe("c")
  const last = await runTracerEffect(
    service.listTraces({
      includeTotal: true,
      limit: 2,
      cursor: first.nextCursor,
    })
  )
  expect(last.items.map((x) => x.id)).toEqual(["b", "a"])
  expect(last.total).toBe(4)
  expect(last.nextCursor).toBeNull()
  const empty = await runTracerEffect(
    service.listTraces({ includeTotal: true, cursor: "a" })
  )
  expect(empty.items).toEqual([])
  expect(empty.total).toBe(4)
  const filtered = await runTracerEffect(
    service.listTraces({
      includeTotal: true,
      filter: 'operation = "chat"',
      limit: 2,
    })
  )
  expect(filtered.items.map((x) => x.id)).toEqual(["c", "b"])
  expect(filtered.total).toBe(3)
  await expectInvalidCursor(
    runTracerEffect(
      service.listTraces({
        includeTotal: true,
        filter: 'operation = "chat"',
        cursor: "d",
      })
    )
  )
  await expectInvalidCursor(
    runTracerEffect(
      service.listTraces({ includeTotal: true, cursor: "missing" })
    )
  )
  await pool.query(
    `INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES ('session', $1, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`,
    [target.projectId]
  )
  await pool.query(
    "UPDATE traces SET session_id = 'session' WHERE id IN ('a', 'b')"
  )
  const sessionPage = await runTracerEffect(
    service.listTraces({ includeTotal: true, sessionId: "session", limit: 1 })
  )
  expect(sessionPage.items.map((x) => x.id)).toEqual(["b"])
  expect(sessionPage.total).toBe(2)
  await expectInvalidCursor(
    runTracerEffect(
      service.listTraces({
        includeTotal: true,
        sessionId: "session",
        cursor: "c",
      })
    )
  )
  const outsider = await createTestTracerService(
    target.databaseUrl,
    "other-project"
  )
  expect(
    (await runTracerEffect(outsider.listTraces({ includeTotal: true }))).total
  ).toBe(0)
  await expectInvalidCursor(
    runTracerEffect(outsider.listTraces({ cursor: "c" }))
  )
})

test("initial schema triggers preserve timestamp offset, precision and invalid-value behavior", async () => {
  const { target, pool } = await fixture()
  await pool.query(
    `INSERT INTO traces (id, project_id, name, operation, status, started_at, ended_at)
    VALUES ('old', $1, 'old', 'chat', 'completed', '2026-09-09T03:00:00.1234+03:00', 'invalid')`,
    [target.projectId]
  )
  let row = (await pool.query("SELECT * FROM traces WHERE id = 'old'")).rows[0]
  expect(row.started_at_ms).toBe(Date.parse(row.started_at))
  expect(row.ended_at_ms).toBeNull()
  await pool.query(
    "UPDATE traces SET started_at = 'broken', ended_at = '2026-09-09T00:00:02Z', started_at_ms = 42 WHERE id = 'old'"
  )
  row = (await pool.query("SELECT * FROM traces WHERE id = 'old'")).rows[0]
  expect(row.started_at_ms).toBeNull()
  expect(row.ended_at_ms).toBe(Date.parse(row.ended_at))
})

test("planner uses span time and trace page indexes on a populated project", async () => {
  const { target, pool } = await fixture()
  await pool.query(
    `INSERT INTO traces (id, project_id, name, operation, status, started_at)
    SELECT 't' || n, $1, 'trace', 'chat', 'completed',
    to_char('2026-01-01'::timestamp + n * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    FROM generate_series(1, 30000) n`,
    [target.projectId]
  )
  await pool.query(`INSERT INTO spans (id, project_id, trace_id, name, kind, status, started_at)
    SELECT id, project_id, id, name, 'llm', status, started_at FROM traces`)
  await pool.query("ANALYZE traces")
  await pool.query("ANALYZE spans")
  const plan = async (statement: string, values: unknown[]) =>
    JSON.stringify(
      (
        await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
          values
        )
      ).rows
    )
  const from = Date.parse("2026-01-10T00:00:00Z")
  const spanPlan = await plan(
    "SELECT id FROM spans WHERE project_id = $1 AND started_at_ms >= $2 AND started_at_ms < $3",
    [target.projectId, from, from + 60000]
  )
  expect(spanPlan).toContain("spans_project_started_ms_idx")
  const timePlan = await plan(
    "SELECT id FROM traces WHERE project_id = $1 AND started_at_ms >= $2 AND started_at_ms < $3",
    [target.projectId, from, from + 60000]
  )
  expect(/traces_project_(started_ms|instant_page)_idx/.test(timePlan)).toBe(
    true
  )
  const tracePlan = await plan(
    "SELECT id FROM traces WHERE project_id = $1 AND (started_at, id) < ($2, $3) ORDER BY started_at DESC, id DESC LIMIT 51",
    [target.projectId, "2026-01-10T00:00:00Z", "t12960"]
  )
  expect(tracePlan).toContain("traces_project_page_idx")
})

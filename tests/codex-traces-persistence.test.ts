import { test, expect } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"
import fixture from "./fixtures/codex/canary.json"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import {
  parseCodexSnapshot,
  persistCodexSnapshot,
} from "../src/server/codex-traces/persist"
import { normalizeCodexTurn } from "../src/lib/codex-traces/normalize"
import { decodeOtlp, mergeTelemetry } from "../src/lib/codex-traces/otlp"
import type { CodexThread } from "../src/lib/codex-traces/types"

test("Codex snapshots persist atomically, survive retry and late delivery, and isolate projects", async () => {
  const target = await createIsolatedPostgres()
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const thread = fixture.thread as CodexThread
    const capture = mergeTelemetry([
      decodeOtlp("traces", fixture.traces),
      decodeOtlp("logs", fixture.logs),
    ])
    const full = parseCodexSnapshot(
      normalizeCodexTurn(
        thread,
        thread.turns[0],
        capture,
        "2026-09-17T06:25:00.000Z"
      )
    )
    const initial = structuredClone(full)
    initial.capturedAt = "2026-09-17T06:24:59.000Z"
    initial.trace.spans = initial.trace.spans.filter(
      (s) => s.name !== "functions.exec_command"
    )
    const created = await persistCodexSnapshot(database, initial)
    expect(created.status).toBe("saved")
    const completed = await persistCodexSnapshot(database, full)
    expect(completed.traceId).toBe(created.traceId)
    const replay = await persistCodexSnapshot(database, full)
    expect(replay.status).toBe("unchanged")
    expect((await persistCodexSnapshot(database, initial)).status).toBe(
      "unchanged"
    )
    const downgrade = normalizeCodexTurn(
      thread,
      thread.turns[0],
      { spans: [], logs: [] },
      "2026-09-17T06:25:30.000Z"
    )
    expect((await persistCodexSnapshot(database, downgrade)).status).toBe(
      "unchanged"
    )
    const partial = structuredClone(full)
    partial.capturedAt = "2026-09-17T06:25:31.000Z"
    partial.trace.attributes!["codex.usage.reconciliation"] = "mismatch"
    expect((await persistCodexSnapshot(database, partial)).status).toBe(
      "unchanged"
    )
    const saved = await database.execute<{
      status: string
      input_tokens: number
      output_tokens: number
      cached_tokens: number
      attrs: Record<string, unknown>
    }>(
      sql`select status,input_tokens,output_tokens,cached_tokens,attributes_json as attrs from traces where id=${created.traceId}`
    )
    expect(saved.rows[0].status).toBe("completed")
    expect(saved.rows[0].input_tokens).toBe(34405)
    expect(saved.rows[0].output_tokens).toBe(53)
    expect(saved.rows[0].cached_tokens).toBe(17024)
    const counts = await database.execute<{
      spans: number
      traces: number
      sessions: number
    }>(
      sql`select (select count(*)::integer from spans) as spans,(select count(*)::integer from traces) as traces,(select count(*)::integer from sessions) as sessions`
    )
    expect(counts.rows[0]).toEqual({ spans: 6, traces: 1, sessions: 1 })
    // A failure after the trace update must roll back the entire snapshot.
    const broken = structuredClone(full)
    broken.capturedAt = "2026-09-17T06:26:00.000Z"
    broken.trace.name = "must roll back"
    broken.trace.spans[0].parentId = "missing-parent"
    await rejects(persistCodexSnapshot(database, broken))
    const after = await database.execute<{ name: string }>(
      sql`select name from traces where id=${created.traceId}`
    )
    expect(after.rows[0].name).toBe(full.trace.name)
    const otherProject = crypto.randomUUID()
    await database.execute(
      sql`insert into project(id,organization_id,name,slug,created_at,updated_at) values(${otherProject},${target.organizationId},'Second','second',NOW(),NOW())`
    )
    const other = createTracerDatabase(target.databaseUrl, {
      projectId: otherProject,
    })
    try {
      await persistCodexSnapshot(other, {
        ...downgrade,
        capturedAt: "2026-09-17T06:24:50.000Z",
      })
      const isolated = await persistCodexSnapshot(other, full)
      expect(isolated.traceId).not.toBe(created.traceId)
      expect(isolated.sessionId).not.toBe(created.sessionId)
      const total = await database.execute<{ count: number }>(
        sql`select count(*)::integer as count from spans`
      )
      expect(total.rows[0].count).toBe(12)
    } finally {
      await closeTracerDatabase(other)
    }
  } finally {
    await closeTracerDatabase(database)
    await target.close()
  }
}, 30_000)

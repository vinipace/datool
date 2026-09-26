import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { getTracerProjectId } from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import { traces } from "@/src/server/tracer/schema"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

test("text search pages preserve null instants, cursor membership and optional totals", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(db, [
        {
          id: "a",
          name: "logodev",
          operation: "test",
          status: "completed",
          startedAt: "2026-09-01",
        },
        {
          id: "b",
          name: "logodev",
          operation: "test",
          status: "completed",
          startedAt: "invalid",
        },
        {
          id: "c",
          name: "logodev",
          operation: "test",
          status: "completed",
          startedAt: "invalid",
        },
        {
          id: "z",
          name: "unmatched",
          operation: "test",
          status: "completed",
          startedAt: "2026-09-01",
        },
      ])
    )
    const service = new TracerService(db)
    for (const includeTotal of [true, false]) {
      const page = (cursor?: string) =>
        runTracerEffect(
          service.listTraces({
            filter: '"gode"',
            limit: 1,
            cursor,
            includeTotal,
          })
        )
      const first = await page()
      const second = await page(first.nextCursor!)
      const third = await page(second.nextCursor!)
      expect([
        first.items[0].id,
        second.items[0].id,
        third.items[0].id,
      ]).toEqual(["c", "b", "a"])
      expect(third.nextCursor).toBeNull()
      expect(first.total).toBe(includeTotal ? 3 : undefined)
      const exhausted = await page("a")
      expect(exhausted.items).toEqual([])
      expect(exhausted.total).toBe(includeTotal ? 3 : undefined)
      expect(exhausted.nextCursor).toBeNull()
      for (const cursor of ["z", "missing", "x' OR true --"]) {
        await rejects(page(cursor), /cursor does not identify a row/)
      }
      const empty = await runTracerEffect(
        service.listTraces({ filter: '"absent"', includeTotal })
      )
      expect(empty.items).toEqual([])
      expect(empty.total).toBe(includeTotal ? 0 : undefined)
    }
  } finally {
    await closeTracerFixture(db)
  }
})

test("text search retains the database payload size guard after selecting IDs", async () => {
  const db = await createTracerFixture()
  try {
    await db.execute(sql`insert into traces (id, project_id, name, operation, status, started_at, input_json)
      values ('large', ${getTracerProjectId(db)}, 'large-match', 'test', 'completed', '2026-09-01',
        json_build_object('text', repeat('x', 9 * 1024 * 1024))::text)`)
    const service = new TracerService(db)
    for (const includeTotal of [true, false]) {
      await rejects(
        runTracerEffect(
          service.listTraces({ filter: '"large-match"', includeTotal })
        ),
        /8 MiB/
      )
    }
  } finally {
    await closeTracerFixture(db)
  }
})

test("text search cursor and total remain scoped to the selected session", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const session = await runTracerEffect(
      service.createSession({ name: "Selected" })
    )
    await db.insert(traces).values(
      scopeRows(db, [
        {
          id: "inside",
          name: "needle",
          operation: "test",
          status: "completed",
          startedAt: "2026-09-01",
          sessionId: session.id,
        },
        {
          id: "outside",
          name: "needle",
          operation: "test",
          status: "completed",
          startedAt: "2026-09-01",
        },
      ])
    )
    for (const includeTotal of [true, false]) {
      const options = {
        filter: '"needle"',
        sessionId: session.id,
        includeTotal,
      }
      const result = await runTracerEffect(service.listTraces(options))
      expect(result.items.map((row) => row.id)).toEqual(["inside"])
      expect(result.total).toBe(includeTotal ? 1 : undefined)
      await rejects(
        runTracerEffect(service.listTraces({ ...options, cursor: "outside" })),
        /cursor does not identify a row/
      )
    }
  } finally {
    await closeTracerFixture(db)
  }
})

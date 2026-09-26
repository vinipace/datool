import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { withWorkspace } from "../src/server/auth/context"
import { workspaceScopes } from "../src/lib/auth/permissions"
import { reviewSessionInputSchema } from "../src/lib/tracer/reviews"
import { traces } from "../src/server/tracer/schema"

test("new reviews default to Untitled Review for omitted or trimmed-empty names", () => {
  for (const name of [undefined, "", " \t\n "])
    expect(
      reviewSessionInputSchema.parse({ name, traceIds: ["trace"] }).name
    ).toBe("Untitled Review")
  expect(
    reviewSessionInputSchema.parse({ name: "  Quality  ", traceIds: ["trace"] })
      .name
  ).toBe("Quality")
})

test("review numbers are project scoped, concurrent, stable, and resolve every review operation", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const foreignDb = createTracerDatabase(target.databaseUrl, {
    projectId: "other",
  })
  const service = new TracerService(db)
  const foreign = new TracerService(foreignDb)
  try {
    await db
      .insert(traces)
      .values({
        id: "trace",
        projectId: target.projectId,
        name: "Trace",
        operation: "test",
        status: "completed",
        startedAt: "2026-09-13T00:00:00Z",
      })
    await db.execute(
      sql`insert into project(id,organization_id,name,slug) values('other',${target.organizationId},'Other','other')`
    )
    await foreignDb
      .insert(traces)
      .values({
        id: "other-trace",
        projectId: "other",
        name: "Other",
        operation: "test",
        status: "completed",
        startedAt: "2026-09-13T00:00:00Z",
      })
    const first = await run(service.reviews.create({ traceIds: ["trace"] }))
    expect(first.number).toBe(1)
    expect(first.name).toBe("Untitled Review")
    const second = await run(
      service.reviews.create({ name: " \t ", traceIds: ["trace"] })
    )
    expect(second.number).toBe(2)
    const other = await run(
      foreign.reviews.create({ traceIds: ["other-trace"] })
    )
    expect(other.number).toBe(1)
    expect((await run(foreign.reviews.get("1"))).id).toBe(other.id)
    expect((await run(service.reviews.get("1"))).id).toBe(first.id)
    await assert.rejects(run(foreign.reviews.get("2")))
    await assert.rejects(run(foreign.reviews.get(first.id)))
    await assert.rejects(run(service.reviews.create({ traceIds: ["missing"] })))
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(service.reviews.create({ traceIds: ["trace"] }))
      )
    )
    expect(
      concurrent.map((session) => session.number).sort((a, b) => a - b)
    ).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    await db.execute(
      sql`delete from review_sessions where project_id=${target.projectId} and number=10`
    )
    expect(
      (await run(service.reviews.create({ traceIds: ["trace"] }))).number
    ).toBe(11)
    const renamed = await run(
      service.reviews.update("1", {
        expectedRevision: first.revision,
        name: "  Custom title  ",
      })
    )
    expect(renamed.name).toBe("Custom title")
    expect(renamed.number).toBe(1)
    const blank = await run(
      service.reviews.update("1", {
        expectedRevision: renamed.revision,
        name: " \n ",
      })
    )
    expect(blank.name).toBe("Custom title")
    expect(blank.revision).toBe(renamed.revision)
    const table = await run(service.reviews.table("1"))
    expect(table.traces[0].id).toBe("trace")
    const item = await run(service.reviews.item("1", first.items[0].id))
    expect(item.sessionId).toBe(first.id)
    const saved = await withWorkspace(
      {
        projectId: target.projectId,
        organizationId: target.organizationId,
        userId: target.ownerId,
        kind: "session",
        scopes: workspaceScopes,
      },
      () =>
        run(
          service.reviews.record("1", item.id, {
            expectedRevision: item.revision,
            notes: "Numbered review",
          })
        )
    )
    expect(saved.notes).toBe("Numbered review")
    const skipped = await run(
      service.reviews.mutateSelection("1", {
        expectedRevision: blank.revision,
        action: "skip",
        items: [{ id: item.id, expectedRevision: saved.revision }],
      })
    )
    expect(skipped.skippedCount).toBe(1)
    expect(skipped.number).toBe(1)
    for (const id of ["0", "2147483648", "999999999999999999999999"])
      await assert.rejects(run(service.reviews.get(id)))
  } finally {
    await closeTracerDatabase(db)
    await closeTracerDatabase(foreignDb)
    await target.close()
  }
}, 30000)

test("number migration orders existing reviews chronologically and preserves review items and names", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    for (const file of (await readdir("migrations"))
      .filter(
        (file) => file.endsWith(".sql") && file < "0015_review_numbers.sql"
      )
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    await seedTestWorkspace(target)
    await pool.query(
      "insert into traces(id,project_id,name,operation,status,started_at) values('trace',$1,'Trace','test','completed','2026-09-13')",
      [target.projectId]
    )
    await pool.query(
      "insert into review_sessions(id,project_id,name,created_at,updated_at) values('newer',$1,'Existing name','2026-09-13','2026-09-13'),('older',$1,'Older name','2026-09-12','2026-09-12')",
      [target.projectId]
    )
    await pool.query(
      "insert into review_items(id,project_id,session_id,trace_id,ordinal,notes) values('item',$1,'newer','trace',0,'Existing notes')",
      [target.projectId]
    )
    await pool.query(
      await readFile("migrations/0015_review_numbers.sql", "utf8")
    )
    expect(
      (
        await pool.query(
          "select id,number,name from review_sessions order by number"
        )
      ).rows
    ).toEqual([
      { id: "older", number: 1, name: "Older name" },
      { id: "newer", number: 2, name: "Existing name" },
    ])
    expect(
      (await pool.query("select session_id,notes from review_items")).rows
    ).toEqual([{ session_id: "newer", notes: "Existing notes" }])
    const next = await pool.query(
      "insert into review_sessions(id,project_id,created_at,updated_at) values('next',$1,'2026-09-14','2026-09-14') returning number,name",
      [target.projectId]
    )
    expect(next.rows).toEqual([{ number: 3, name: "Untitled Review" }])
  } finally {
    await pool.end()
    await target.close()
  }
}, 30000)

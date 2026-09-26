import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import {
  seedTestWorkspace,
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"
import {
  datasets,
  datasetItems,
  evalRuns,
  evalRunTargets,
  traces,
} from "../src/server/tracer/schema"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect } from "../src/server/tracer/effect"

test("item run history matches live references and frozen cases before pagination, without duplicate traces", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  const time = "2026-09-01T00:00:00Z"
  try {
    await db.insert(datasets).values(
      scopeRows(db, {
        id: "dataset",
        name: "Cases",
        createdAt: time,
        updatedAt: time,
      })
    )
    await db.insert(datasetItems).values(
      scopeRows(
        db,
        ["item", "other"].map((id) => ({
          id,
          datasetId: "dataset",
          inputJson: "null",
          createdAt: time,
          updatedAt: time,
        }))
      )
    )
    await db.insert(traces).values(
      scopeRows(
        db,
        ["live", "frozen", "unrelated", "empty"].map((id) => ({
          id,
          name: `Answer ${id}`,
          operation: "test",
          status: "completed",
          startedAt: time,
          inputJson: JSON.stringify({ question: id }),
          outputJson: JSON.stringify({ answer: id }),
        }))
      )
    )
    await db.insert(evalRuns).values(
      scopeRows(
        db,
        ["live", "frozen", "unrelated", "empty"].map((id) => ({
          id,
          datasetId: "dataset",
          status: "completed",
          createdAt: time,
        }))
      )
    )
    await db.insert(evalRunTargets).values(
      scopeRows(
        db,
        [
          { id: "live-1", runId: "live", datasetItemId: "item", ordinal: 0 },
          { id: "live-2", runId: "live", datasetItemId: "item", ordinal: 1 },
          {
            id: "frozen",
            runId: "frozen",
            datasetItemId: null,
            snapshotJson: JSON.stringify({ datasetItem: { id: "item" } }),
            ordinal: 0,
          },
          {
            id: "unrelated",
            runId: "unrelated",
            datasetItemId: "other",
            ordinal: 0,
          },
        ].map((row) => ({ ...row, traceId: row.runId, createdAt: time }))
      )
    )

    const options = {
      datasetItemId: "item",
      limit: 1,
      includeTotal: true,
    }
    const first = await runTracerEffect(service.listTraces(options))
    expect(first.total).toBe(2)
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await runTracerEffect(
      service.listTraces({ ...options, cursor: first.nextCursor })
    )
    expect(
      new Set([...first.items, ...second.items].map((run) => run.id))
    ).toEqual(new Set(["live", "frozen"]))
    expect(second.nextCursor).toBeNull()
    expect(
      (await runTracerEffect(service.listTraces({ datasetItemId: "missing" })))
        .items
    ).toHaveLength(0)
    expect(
      (await runTracerEffect(service.listTraces({ datasetItemId: "ITEM" })))
        .items
    ).toHaveLength(0)
    expect(first.items[0].input).toEqual({ question: first.items[0].id })
    expect(first.items[0].output).toEqual({ answer: first.items[0].id })
    expect(
      (
        await runTracerEffect(
          service.listTraces({
            datasetItemId: "item",
            filter: 'name = "missing"',
          })
        )
      ).items
    ).toHaveLength(0)
    await rejects(runTracerEffect(service.listTraces({ ...options, cursor: "unrelated" })), /cursor/)
    expect(
      (await runTracerEffect(service.listTraces({ includeTotal: true }))).total
    ).toBe(4)
  } finally {
    await closeTracerFixture(db)
  }
})

test("item run history stays in the selected project even for the same frozen case ID", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const otherProject = {
    ...target,
    projectId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
  }
  await seedTestWorkspace(otherProject)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const otherDb = createTracerDatabase(target.databaseUrl, {
    projectId: otherProject.projectId,
    schema: target.schema,
  })
  const time = "2026-09-01T00:00:00Z"
  try {
    for (const [database, id] of [
      [db, "own"],
      [otherDb, "foreign"],
    ] as const) {
      await database.insert(traces).values(
        scopeRows(database, {
          id: `trace-${id}`,
          name: "Answer",
          operation: "test",
          status: "completed",
          startedAt: time,
        })
      )
      await database
        .insert(evalRuns)
        .values(
          scopeRows(database, { id, status: "completed", createdAt: time })
        )
      await database.insert(evalRunTargets).values(
        scopeRows(database, {
          id: `target-${id}`,
          runId: id,
          traceId: `trace-${id}`,
          ordinal: 0,
          createdAt: time,
          snapshotJson: JSON.stringify({ datasetItem: { id: "same-case" } }),
        })
      )
    }
    const page = await runTracerEffect(
      new TracerService(db).listTraces({
        datasetItemId: "same-case",
        includeTotal: true,
      })
    )
    expect(page.items.map((run) => run.id)).toEqual(["trace-own"])
    expect(page.total).toBe(1)
  } finally {
    await closeTracerDatabase(db)
    await closeTracerDatabase(otherDb)
    await target.close()
  }
})

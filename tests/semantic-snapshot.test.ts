import { afterEach, describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"

import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import {
  closeTracerDatabase,
  createTracerDatabase,
  getTracerSnapshotClientFactory,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { traces } from "@/src/server/tracer/schema"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: { database: TracerDatabase; target: IsolatedPostgres }[] = []

async function capturedError(operation: () => Promise<unknown>) {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error
  }
}

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeDatabase() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  return { database, projectId: target.projectId }
}

function trace(id: string, projectId: string) {
  return {
    id,
    projectId,
    name: id,
    operation: "semantic.snapshot",
    startedAt: "2026-09-07T12:00:00.000Z",
    status: "completed",
  }
}

describe("semantic PostgreSQL snapshot connection isolation", () => {
  test("disables JIT only inside the read snapshot and restores the pooled session", async () => {
    const { database } = await makeDatabase()
    const connect = getTracerSnapshotClientFactory(database)!
    const before = await connect()
    await before.query("SET jit = on")
    const pid = (await before.query("select pg_backend_pid() as pid")).rows[0]
      .pid
    before.release()
    const result = await createSemanticSnapshotRunner(database)(
      async (snapshot) =>
        (
          await snapshot.execute(sql`select pg_backend_pid() as pid, current_setting('jit') as jit,
        current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`)
        ).rows[0]
    )
    expect(result).toEqual({
      pid,
      jit: "off",
      read_only: "on",
      isolation: "repeatable read",
    })
    const after = await connect()
    try {
      expect(
        (
          await after.query(
            "select pg_backend_pid() as pid, current_setting('jit') as jit"
          )
        ).rows[0]
      ).toEqual({ pid, jit: "on" })
    } finally {
      after.release()
    }
  })

  test("pins a repeatable-read view before asOf and excludes a later committed writer", async () => {
    const { database, projectId } = await makeDatabase()
    await database
      .insert(traces)
      .values(trace("tr_before_snapshot_acquisition", projectId))

    const runner = createSemanticSnapshotRunner(database)
    const result = await runner(async (snapshot, asOf) => {
      await database
        .insert(traces)
        .values(trace("tr_writer_after_acquisition", projectId))

      const rows = await snapshot
        .select({ id: traces.id })
        .from(traces)
        .where(eq(traces.projectId, snapshot.projectId))
      return {
        asOf,
        ids: rows.map((row) => row.id).sort(),
        projectId: snapshot.projectId,
      }
    })

    expect(result.asOf).toBeInstanceOf(Date)
    expect(result.projectId).toBe(projectId)
    expect(result.ids).toEqual(["tr_before_snapshot_acquisition"])

    const afterRelease = await database
      .select({ id: traces.id })
      .from(traces)
      .where(eq(traces.projectId, projectId))
      .orderBy(traces.id)
    expect(afterRelease).toEqual([
      { id: "tr_before_snapshot_acquisition" },
      { id: "tr_writer_after_acquisition" },
    ])
  })

  test("rolls back and releases a failed read transaction before later writes", async () => {
    const { database, projectId } = await makeDatabase()
    const runner = createSemanticSnapshotRunner(database)

    const failure = await capturedError(() =>
      runner(async () => {
        throw new Error("forced semantic model failure")
      })
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("forced semantic model failure")

    await database
      .insert(traces)
      .values(trace("tr_after_snapshot_failure", projectId))
    const rows = await database
      .select({ id: traces.id })
      .from(traces)
      .where(eq(traces.projectId, projectId))
    expect(rows).toEqual([{ id: "tr_after_snapshot_failure" }])
  })
})

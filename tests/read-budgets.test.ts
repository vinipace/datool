import { test, expect } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { boundedReadTransaction } from "@/src/server/tracer/read-transaction"
import { withReadBudget } from "@/src/server/semantic/read-budget"

test("a deadline aborts an owned read connection and releases admission for the next read", async () => {
  const target = await createIsolatedPostgres()
  let database: ReturnType<typeof createTracerDatabase> | undefined
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const scoped = database
    const error = await withReadBudget(target.projectId, () =>
      boundedReadTransaction(scoped, Date.now() + 50, async (tx) => {
        await tx.execute(sql`select pg_sleep(2)`)
      })
    ).then(
      () => null,
      (error) => error
    )
    expect(error).toMatchObject({ code: "READ_TIMEOUT" })
    const result = await withReadBudget(target.projectId, () =>
      boundedReadTransaction(scoped, Date.now() + 1000, (tx) =>
        tx.execute(sql`select 42 as value`)
      )
    )
    expect(result.rows[0].value).toBe(42)
  } finally {
    if (database) await closeTracerDatabase(database)
    await target.close()
  }
})

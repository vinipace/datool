import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace, type IsolatedPostgres } from "./postgres"
import { createTracerDatabase, closeTracerDatabase, type TracerDatabase } from "../../src/server/tracer/db"
const fixtures = new WeakMap<TracerDatabase, IsolatedPostgres>()
export async function createTracerFixture() {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const db = createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema })
    fixtures.set(db, target)
    return db
  } catch (error) { await target.close(); throw error }
}
export async function closeTracerFixture(db: TracerDatabase) {
  await closeTracerDatabase(db)
  await fixtures.get(db)?.close()
}
export function reopenTracerFixture(db: TracerDatabase) {
  const target = fixtures.get(db)!
  return createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema })
}
import { getTracerProjectId } from "../../src/server/tracer/db"
export function scopeRows<T extends object>(db: TracerDatabase, rows: T[]): (T & { projectId: string })[]
export function scopeRows<T extends object>(db: TracerDatabase, rows: T): T & { projectId: string }
export function scopeRows<T extends object>(db: TracerDatabase, rows: T | T[]) {
  const scope = (row: T) => ({ ...row, projectId: getTracerProjectId(db) })
  return Array.isArray(rows) ? rows.map(scope) : scope(rows)
}

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { Pool } from "pg"

export type IsolatedPostgres = {
  databaseUrl: string
  organizationId: string
  ownerId: string
  projectId: string
  schema: string
  close: () => Promise<void>
}

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * Returns a disposable, schema-isolated PostgreSQL target for one test. Tests
 * must opt in with DATOOL_TEST_DATABASE_URL; DATABASE_URL is deliberately
 * ignored so a developer's configured database cannot be modified by tests.
 */
export async function createIsolatedPostgres(): Promise<IsolatedPostgres> {
  const baseUrl = requireTestDatabaseUrl()
  const schema = `datool_test_${crypto.randomUUID().replaceAll("-", "")}`
  const organizationId = crypto.randomUUID()
  const ownerId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const admin = new Pool({ connectionString: baseUrl })

  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
  } catch (error) {
    await admin.end()
    throw error
  }

  return {
    databaseUrl: withSearchPath(baseUrl, schema),
    organizationId,
    ownerId,
    projectId,
    schema,
    async close() {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
      } finally {
        await admin.end()
      }
    },
  }
}

/**
 * Seeds the standard Better Auth organization/project hierarchy after the
 * caller has applied migrations to the isolated schema.
 */
export async function seedTestWorkspace(target: IsolatedPostgres) {
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    const now = new Date()
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, $4, $4)`,
      [target.ownerId, "Test owner", `${target.ownerId}@example.test`, now],
    )
    await pool.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, $4)`,
      [target.organizationId, "Test organization", `test-${target.organizationId.slice(0, 12)}`, now],
    )
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [crypto.randomUUID(), target.organizationId, target.ownerId, now],
    )
    await pool.query(
      `INSERT INTO project (id, organization_id, name, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [target.projectId, target.organizationId, "Test project", "test-project", now],
    )
  } finally {
    await pool.end()
  }
}

/** Applies every checked-in PostgreSQL migration to this test schema only. */
export async function migrateIsolatedPostgres(target: IsolatedPostgres) {
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    const directory = join(process.cwd(), "migrations")
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()
    for (const file of files) {
      await pool.query(await readFile(join(directory, file), "utf8"))
    }
  } finally {
    await pool.end()
  }
}

function requireTestDatabaseUrl() {
  const value = process.env.DATOOL_TEST_DATABASE_URL
  if (!value) {
    throw new Error(
      "DATOOL_TEST_DATABASE_URL is required for PostgreSQL integration tests. It must point to a disposable loopback database; DATABASE_URL is never used by tests.",
    )
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("DATOOL_TEST_DATABASE_URL must be an absolute PostgreSQL URL.")
  }

  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error("DATOOL_TEST_DATABASE_URL must use a local loopback PostgreSQL server.")
  }

  if (value === process.env.DATABASE_URL) {
    throw new Error("DATOOL_TEST_DATABASE_URL must not equal DATABASE_URL.")
  }

  return value
}

function withSearchPath(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl)
  const existingOptions = url.searchParams.get("options")
  const searchPathOption = `-c search_path=${schema},public`
  url.searchParams.set("options", existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption)
  return url.toString()
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

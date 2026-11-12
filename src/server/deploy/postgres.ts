import { environmentOf, resourceScope } from "./context"
import { createHash, randomBytes } from "node:crypto"
import { Client, Query, types } from "pg"
import { sql } from "drizzle-orm"
import {
  generateDrizzleJson,
  generateMigration,
  type DrizzleSnapshotJSON,
} from "drizzle-kit/api"
import { z } from "zod"
import type { DeploymentContext } from "./context"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "../model-providers/secrets"
import { TracerError } from "../tracer/errors"
import { getTracerWritePool } from "../tracer/db"

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")
type Credentials = { owner: string; writer: string; reader: string }

/** Serialize preparation, migrations and publication, including the first deploy. */
export async function withDeploymentLock<T>(
  context: DeploymentContext,
  run: () => Promise<T>
) {
  const client = await getTracerWritePool(context.database).connect()
  try {
    await client.query("SET lock_timeout='30s'")
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      `deploy:${resourceScope(context)}`,
    ])
    return await run()
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `deploy:${resourceScope(context)}`,
      ])
      .catch(() => {})
    await client.query("RESET lock_timeout").catch(() => {})
    client.release()
  }
}
async function credentials(
  context: DeploymentContext
): Promise<Credentials | null> {
  const rows = await context.database.execute<{
    encrypted_credentials: string
  }>(
    sql`SELECT encrypted_credentials FROM project_postgres WHERE project_id=${context.projectId} AND environment=${environmentOf(context)}`
  )
  return rows.rows[0]
    ? JSON.parse(
        decryptProviderKey(
          rows.rows[0].encrypted_credentials,
          resourceScope(context),
          "project-postgres"
        )
      )
    : null
}
function client(url: string, stream = false) {
  const connection = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    query_timeout: stream ? 0 : 20_000,
    // Drizzle's proxy maps PostgreSQL wire strings itself, including timestamp modes.
    types: {
      getTypeParser: (oid, format) =>
        [1082, 1114, 1184, 1186, 1231, 1115, 1185, 1187, 1182].includes(oid)
          ? (value: string) => value
          : types.getTypeParser(oid, format),
    },
  })
  connection.on("error", () => {
    /* Active queries reject; idle connection failures must not crash the host. */
  })
  return connection
}
async function provision(context: DeploymentContext) {
  const previous = await credentials(context)
  if (previous) return previous
  const configured = process.env.DATOOL_PROJECT_DATABASE_ADMIN_URL
  if (!configured)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Configure DATOOL_PROJECT_DATABASE_ADMIN_URL to enable project PostgreSQL databases (CREATEDB and CREATEROLE required).",
      { details: { reason: "PROJECT_DATABASE_NOT_CONFIGURED" } }
    )
  const admin = client(configured)
  // Random suffix avoids adopting an existing database or role after an interrupted provision.
  const name = `dtp_${digest(resourceScope(context)).slice(0, 16)}_${randomBytes(6).toString("hex")}`
  const roles = {
    owner: `${name}_owner`,
    writer: `${name}_writer`,
    reader: `${name}_reader`,
  }
  const result = {} as Credentials
  const created: string[] = []
  let databaseCreated = false
  let bindingAttempted = false
  await admin.connect()
  try {
    for (const [kind, role] of Object.entries(roles)) {
      const password = randomBytes(32).toString("hex")
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10`
      )
      created.push(role)
      const url = new URL(configured)
      url.username = role
      url.password = password
      url.pathname = `/${name}`
      // Never inherit operator options (search_path, role, service, etc.) into tenant sessions.
      for (const key of [...url.searchParams.keys()])
        if (!["sslmode", "sslrootcert", "sslcert", "sslkey"].includes(key))
          url.searchParams.delete(key)
      result[kind as keyof Credentials] = url.toString()
    }
    await admin.query(
      `CREATE DATABASE ${quote(name)} OWNER ${quote(roles.owner)} TEMPLATE template0 CONNECTION LIMIT 20`
    )
    databaseCreated = true
    await admin.query(`REVOKE ALL ON DATABASE ${quote(name)} FROM PUBLIC`)
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quote(name)} TO ${quote(roles.writer)},${quote(roles.reader)}`
    )
    const owner = client(result.owner)
    await owner.connect()
    try {
      await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${quote(roles.writer)},${quote(roles.reader)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${quote(roles.writer)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(roles.reader)};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${quote(roles.writer)};
        ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`)
    } finally {
      await owner.end()
    }
    // An interrupted INSERT acknowledgement can still have committed. Retain the
    // database once binding starts; never leave a committed binding pointing at a dropped database.
    bindingAttempted = true
    await context.database.execute(
      sql`INSERT INTO project_postgres(project_id,environment,encrypted_credentials) VALUES(${context.projectId},${environmentOf(context)},${encryptProviderKey(JSON.stringify(result), resourceScope(context), "project-postgres")})`
    )
    return result
  } catch (error) {
    if (databaseCreated && !bindingAttempted)
      await admin
        .query(`DROP DATABASE ${quote(name)} WITH (FORCE)`)
        .catch(() => {})
    if (!bindingAttempted)
      for (const role of created.reverse())
        await admin.query(`DROP ROLE ${quote(role)}`).catch(() => {})
    throw error
  } finally {
    await admin.end()
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
function snapshot(raw: unknown): DrizzleSnapshotJSON {
  const data = z
    .object({
      version: z.literal("7"),
      dialect: z.literal("postgresql"),
      tables: z.record(z.string(), z.record(z.string(), z.json())),
      enums: z.record(z.string(), z.json()),
      schemas: z.record(z.string(), z.json()),
      roles: z.record(z.string(), z.json()),
      policies: z.record(z.string(), z.json()),
      views: z.record(z.string(), z.json()),
      sequences: z.record(z.string(), z.json()),
    })
    .passthrough()
    .parse(raw)
  if (
    Buffer.byteLength(JSON.stringify(data)) > 512 * 1024 ||
    Object.keys(data.tables).length > 100
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "PostgreSQL schemas support up to 100 tables and 512 KiB of metadata."
    )
  for (const key of [
    "schemas",
    "roles",
    "policies",
    "views",
    "sequences",
  ] as const)
    if (Object.keys(data[key]).length)
      throw new TracerError(
        "VALIDATION_ERROR",
        `Project schemas currently support public tables and enums; ${key} are not supported.`
      )
  for (const table of Object.values(data.tables)) {
    if (
      table.isRLSEnabled ||
      Object.keys((table.policies ?? {}) as object).length
    )
      throw new TracerError(
        "VALIDATION_ERROR",
        "Project table policies and RLS are not supported."
      )
    if (table.schema !== "" && table.schema !== "public")
      throw new TracerError(
        "VALIDATION_ERROR",
        "Project tables must use the public schema."
      )
  }
  for (const value of Object.values(data.enums))
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schema !== "public"
    )
      throw new TracerError(
        "VALIDATION_ERROR",
        "Project enums must use the public schema."
      )
  return data as unknown as DrizzleSnapshotJSON
}
/** Old definitions must remain identical: no drops, renames or in-place type changes. */
function additive(previous: DrizzleSnapshotJSON, next: DrizzleSnapshotJSON) {
  const before = previous as unknown as {
    tables: Record<string, Record<string, unknown>>
    enums: Record<string, unknown>
  }
  const after = next as unknown as typeof before
  for (const [name, value] of Object.entries(before.enums))
    if (canonical(value) !== canonical(after.enums[name]))
      throw new TracerError(
        "VALIDATION_ERROR",
        `Automatic migrations cannot remove or change enum ${name}.`,
        { details: { reason: "PROJECT_DATABASE_DESTRUCTIVE_CHANGE" } }
      )
  for (const [name, table] of Object.entries(before.tables)) {
    const current = after.tables[name]
    if (!current)
      throw new TracerError(
        "VALIDATION_ERROR",
        `Automatic migrations cannot drop or rename table ${name}.`,
        { details: { reason: "PROJECT_DATABASE_DESTRUCTIVE_CHANGE" } }
      )
    for (const [key, value] of Object.entries(table)) {
      if (
        [
          "columns",
          "indexes",
          "foreignKeys",
          "compositePrimaryKeys",
          "uniqueConstraints",
          "checkConstraints",
          "policies",
        ].includes(key)
      ) {
        for (const [entry, definition] of Object.entries(value as object))
          if (
            canonical(definition) !==
            canonical((current[key] as Record<string, unknown>)?.[entry])
          )
            throw new TracerError(
              "VALIDATION_ERROR",
              `Automatic migrations cannot remove or change ${name}.${entry}. Use an additive migration.`,
              { details: { reason: "PROJECT_DATABASE_DESTRUCTIVE_CHANGE" } }
            )
      } else if (canonical(value) !== canonical(current[key]))
        throw new TracerError(
          "VALIDATION_ERROR",
          `Automatic migrations cannot change ${name}.${key}.`,
          { details: { reason: "PROJECT_DATABASE_DESTRUCTIVE_CHANGE" } }
        )
    }
  }
}
export async function planProjectDatabase(
  context: DeploymentContext,
  raw: unknown
) {
  const next = snapshot(raw)
  let previous = generateDrizzleJson({})
  let appliedMigration: { hash: string; statements: string[] } | undefined
  const access = await credentials(context)
  if (access) {
    const owner = client(access.owner)
    await owner.connect()
    try {
      const exists = await owner.query(
        "SELECT to_regclass('datool_meta.migrations') AS name"
      )
      if (exists.rows[0].name) {
        const history = await owner.query(
          "SELECT hash,snapshot,statements FROM datool_meta.migrations ORDER BY sequence DESC LIMIT 1"
        )
        previous = history.rows[0]?.snapshot ?? previous
        if (history.rows[0])
          appliedMigration = {
            hash: history.rows[0].hash,
            statements: history.rows[0].statements,
          }
      }
    } finally {
      await owner.end()
    }
  }
  additive(previous, next)
  // Snapshot UUIDs are generation artifacts, not schema identity.
  const definition = Object.fromEntries(
    Object.entries(next).filter(
      ([key]) => !["id", "prevId", "_meta"].includes(key)
    )
  )
  const hash = digest(canonical(definition))
  next.prevId = previous.id
  next.id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  const statements = await generateMigration(previous, next)
  return {
    hash,
    statements,
    snapshot: next,
    migration: statements.length ? { hash, statements } : appliedMigration,
  }
}
export async function migrateProjectDatabase(
  context: DeploymentContext,
  plan: Awaited<ReturnType<typeof planProjectDatabase>>,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const access = await provision(context)
  if (!plan.statements.length) return
  const owner = client(access.owner)
  await owner.connect()
  let committing = false
  try {
    await owner.query("BEGIN")
    await owner.query("SET LOCAL lock_timeout='5s'")
    await owner.query(
      "CREATE SCHEMA IF NOT EXISTS datool_meta; REVOKE ALL ON SCHEMA datool_meta FROM PUBLIC; CREATE TABLE IF NOT EXISTS datool_meta.migrations (sequence bigint GENERATED ALWAYS AS IDENTITY, hash text PRIMARY KEY, snapshot jsonb NOT NULL, statements jsonb NOT NULL)"
    )
    for (const statement of plan.statements) {
      signal.throwIfAborted()
      await owner.query(
        Object.assign({ text: statement }, { queryMode: "extended" })
      )
    }
    signal.throwIfAborted()
    // DDL and its migration history commit atomically in the project database.
    await owner.query(
      "INSERT INTO datool_meta.migrations(hash,snapshot,statements) VALUES($1,$2,$3)",
      [
        plan.hash,
        JSON.stringify(plan.snapshot),
        JSON.stringify(plan.statements),
      ]
    )
    committing = true
    await owner.query("COMMIT")
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => {})
    const code = (error as { code?: string }).code
    throw new TracerError(
      "VALIDATION_ERROR",
      committing
        ? "The migration commit was not confirmed. Preview migrations before retrying."
        : `PostgreSQL migration failed (${code && /^[0-9A-Z]{5}$/.test(code) ? code : "SQL error"}). Its changes were rolled back.`,
      {
        cause: error,
        details: {
          reason: committing
            ? "PROJECT_DATABASE_COMMIT_UNKNOWN"
            : "PROJECT_DATABASE_MIGRATION_FAILED",
          sqlState: code && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown",
        },
      }
    )
  } finally {
    await owner.end()
  }
}

export async function queryProjectDatabase(
  context: DeploymentContext,
  raw: unknown,
  readOnly: boolean,
  signal: AbortSignal
) {
  const input = z
    .object({
      sql: z
        .string()
        .min(1)
        .max(64 * 1024),
      params: z.array(z.json()).max(1000),
      method: z.enum(["all", "execute"]),
    })
    .strict()
    .parse(raw)
  if (Buffer.byteLength(JSON.stringify(input.params)) > 256 * 1024)
    throw new TracerError("VALIDATION_ERROR", "SQL parameters exceed 256 KiB.")
  const access = await credentials(context)
  if (!access)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Deploy schema.ts before using PostgreSQL."
    )
  const connection = client(readOnly ? access.reader : access.writer, true)
  let closing: Promise<void> | undefined
  const close = () => (closing ??= connection.end().catch(() => {}))
  const abort = () => {
    void close()
  }
  signal.throwIfAborted()
  await connection.connect()
  const wire = (
    connection as unknown as {
      connection: { stream: import("node:stream").Duplex }
    }
  ).connection.stream
  let wireBytes = 0
  let wireError: Error | undefined
  const budget = (chunk: Buffer) => {
    wireBytes += chunk.length
    if (wireBytes > 2 * 1024 * 1024) {
      wireError = new Error(
        "SQL wire response exceeds 2 MiB; select smaller values and fewer rows."
      )
      abort()
    }
  }
  // pg's row event runs after a complete field is decoded. Bound the underlying
  // stream too, so a single oversized text/JSON value cannot exhaust host memory.
  wire.prependListener("data", budget)
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    if (readOnly) await connection.query("BEGIN READ ONLY")
    // Stream rows to enforce the transport bound before buffering the entire result.
    const rows: unknown[] = []
    let bytes = 0
    await new Promise<void>((resolve, reject) => {
      const query = new Query(
        Object.assign(
          {
            text: input.sql,
            values: input.params,
            ...(input.method === "all" ? { rowMode: "array" } : {}),
          },
          { queryMode: "extended" }
        )
      )
      query.on("row", (row) => {
        bytes += Buffer.byteLength(JSON.stringify(row))
        if (rows.length >= 1000 || bytes > 1024 * 1024) {
          reject(
            new Error("SQL results exceed 1000 rows or 1 MiB; add a limit.")
          )
          abort()
        } else rows.push(row)
      })
      query.on("error", reject)
      query.on("end", () => resolve())
      connection.query(query)
    })
    return { rows }
  } catch (error) {
    throw wireError ?? error
  } finally {
    wire.removeListener("data", budget)
    signal.removeEventListener("abort", abort)
    await close()
  }
}

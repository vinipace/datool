import type { PoolClient } from "pg"
import { Pool } from "pg"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import {
  assertDatabaseConfiguration,
  db as sharedPool,
  analyticsDb,
} from "@/lib/db"
import * as schema from "@/src/server/tracer/schema"
import { billingDatabaseUrl } from "@/lib/billing-database"

export type TracerDatabase = NodePgDatabase<typeof schema>
export type TracerSnapshotClientFactory = () => Promise<PoolClient>

type ScopedDatabase = typeof globalThis & {
  datoolTracerProjectIds?: WeakMap<object, string>
  datoolTracerSnapshotFactories?: WeakMap<object, TracerSnapshotClientFactory>
  datoolTracerClosers?: WeakMap<object, () => Promise<void>>
}

function projectIds() {
  const registry = globalThis as ScopedDatabase
  registry.datoolTracerProjectIds ??= new WeakMap()
  return registry.datoolTracerProjectIds
}

function snapshotFactories() {
  const registry = globalThis as ScopedDatabase
  registry.datoolTracerSnapshotFactories ??= new WeakMap()
  return registry.datoolTracerSnapshotFactories
}

function closers() {
  const registry = globalThis as ScopedDatabase
  registry.datoolTracerClosers ??= new WeakMap()
  return registry.datoolTracerClosers
}

export function registerTracerProjectId(
  database: TracerDatabase,
  projectId: string
): TracerDatabase {
  if (!projectId.trim()) {
    throw new Error(
      "A non-empty projectId is required for tracer database access."
    )
  }

  projectIds().set(database, projectId)
  return database
}

export function getTracerProjectId(database: TracerDatabase): string {
  const projectId = projectIds().get(database)
  if (!projectId) {
    throw new Error(
      "Tracer database access requires a registered projectId. Use createTracerDatabase(..., { projectId }) or registerTracerProjectId()."
    )
  }
  return projectId
}

export function getTracerSnapshotClientFactory(
  database: TracerDatabase
): TracerSnapshotClientFactory | undefined {
  return snapshotFactories().get(database)
}

/** Closes only a pool created for an isolated URL; shared app pools stay open. */
export async function closeTracerDatabase(database: TracerDatabase) {
  await closers().get(database)?.()
  closers().delete(database)
  projectIds().delete(database)
  snapshotFactories().delete(database)
}

export type TracerDatabaseOptions = {
  projectId: string
  /** A validated PostgreSQL schema name for isolated test databases. */
  schema?: string
}

/**
 * Creates a scoped Drizzle PostgreSQL handle. The default path uses the shared
 * application Pool; a supplied URL is reserved for isolated test schemas.
 */
export function createTracerDatabase(
  databaseUrl: string | undefined,
  options: TracerDatabaseOptions
): TracerDatabase {
  if (options.schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.schema)) {
    throw new Error(
      "Tracer database schema names must be simple PostgreSQL identifiers."
    )
  }

  if (databaseUrl) {
    let protocol: string
    try {
      protocol = new URL(databaseUrl).protocol
    } catch {
      throw new Error(
        "Tracer database URLs must be valid PostgreSQL connection URLs."
      )
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      throw new Error("Tracer database URLs must use postgres or postgresql.")
    }
  }

  const pool = databaseUrl
    ? new Pool({
        connectionString: billingDatabaseUrl(
          databaseUrl,
          options.schema ? `-c search_path=${options.schema},public` : ""
        ),
      })
    : sharedPool
  if (!databaseUrl) assertDatabaseConfiguration()

  const database = drizzle({ client: pool, schema })
  registerTracerProjectId(database, options.projectId)
  snapshotFactories().set(database, () =>
    (databaseUrl ? pool : analyticsDb).connect()
  )
  closers().set(
    database,
    databaseUrl ? () => pool.end() : async () => undefined
  )
  return database
}

/**
 * Tracer DDL is maintained by the additive application migration command.
 * This guard remains for callers that formerly auto-migrated SQLite files.
 */
export async function migrateTracerDatabase(database: TracerDatabase) {
  void database
  throw new Error(
    "Run `bun run db:migrate` before using the PostgreSQL tracer database."
  )
}

/** Carry project identity and read-snapshot configuration into an ingestion transaction. */
export function scopedTracerTransaction(
  parent: TracerDatabase,
  transaction: unknown
): TracerDatabase {
  const database = transaction as TracerDatabase
  registerTracerProjectId(database, getTracerProjectId(parent))
  const factory = getTracerSnapshotClientFactory(parent)
  if (factory) snapshotFactories().set(database, factory)
  return database
}

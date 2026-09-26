import { createHash } from "node:crypto"
import { PgDialect } from "drizzle-orm/pg-core"
import { readMeasurement, readTelemetry } from "./telemetry"
import {
  acquireReadAsync,
  ReadBudgetError,
  READ_BATCH_DEADLINE_MS,
} from "./read-budget"
import type { PoolClient } from "pg"

import { Effect } from "effect"
import { drizzle } from "drizzle-orm/node-postgres"

import * as schema from "@/src/server/tracer/schema"
import {
  getTracerProjectId,
  getTracerSnapshotClientFactory,
  registerTracerProjectId,
  type TracerDatabase,
  type TracerSnapshotClientFactory,
} from "@/src/server/tracer/db"

/**
 * A snapshot is always bound to the project carried by the tracer database.
 * Metric models must use `projectId` in each persisted-fact predicate; a
 * project-scoped database handle alone is not an implicit SQL filter.
 */
export type SemanticReadTransaction = Pick<
  TracerDatabase,
  "select" | "execute"
> &
  Readonly<{ projectId: string }>

export type SemanticSnapshotRunner = <Value>(
  callback: (snapshot: SemanticReadTransaction, asOf: Date) => Promise<Value>
) => Promise<Value>

type OpenSemanticReadSnapshot = {
  asOf: Date
  client: PoolClient
  snapshot: SemanticReadTransaction
  releaseAdmission: () => void
}

export class SemanticSnapshotConfigurationError extends Error {
  readonly _tag = "SemanticSnapshotConfigurationError"

  constructor(message: string) {
    super(message)
    this.name = "SemanticSnapshotConfigurationError"
  }
}

function asSnapshotError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("Unable to open or close the semantic read snapshot.", {
        cause: error,
      })
}

function resolveSnapshotClientFactory(
  database: TracerDatabase
): TracerSnapshotClientFactory {
  const clientFactory = getTracerSnapshotClientFactory(database)
  if (!clientFactory) {
    throw new SemanticSnapshotConfigurationError(
      "This semantic service received a database without a registered PostgreSQL snapshot connection. Create a scoped tracer database through createTracerDatabase."
    )
  }
  return clientFactory
}

async function openSemanticReadSnapshot(
  database: TracerDatabase,
  clientFactory: TracerSnapshotClientFactory
): Promise<OpenSemanticReadSnapshot> {
  const deadline = Date.now() + READ_BATCH_DEADLINE_MS
  const releaseAdmission = await acquireReadAsync(
    getTracerProjectId(database),
    2000,
    "analytics"
  )
  let client: PoolClient
  try {
    client = await clientFactory()
  } catch (error) {
    releaseAdmission()
    throw error
  }
  let opened = false
  try {
    // PostgreSQL fixes the REPEATABLE READ view when the first query runs.
    // Pin it before exposing the snapshot or producing `asOf`, so a writer
    // that commits between acquisition and a model's first query is excluded.
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    )
    opened = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'")
    // Compilation costs more than execution for these bounded dashboard reads.
    // Keep the choice inside this transaction, away from pooled write sessions.
    await client.query("SET LOCAL jit = off")
    await client.query("SELECT 1")
    const projectId = getTracerProjectId(database)
    const snapshotDatabase = drizzle({
      client,
      schema,
    }) as unknown as TracerDatabase
    registerTracerProjectId(snapshotDatabase, projectId)
    const execute = snapshotDatabase.execute.bind(snapshotDatabase)
    const boundedExecute = async (
      query: Parameters<TracerDatabase["execute"]>[0]
    ) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new ReadBudgetError(
          "READ_TIMEOUT",
          "The analytics snapshot exceeded its deadline."
        )
      await client.query("select set_config('statement_timeout', $1, true)", [
        String(Math.min(10_000, remaining)),
      ])
      const started = performance.now()
      const fingerprint = readTelemetry.hasSubscribers
        ? createHash("sha256")
            .update(
              typeof query === "string"
                ? query
                : new PgDialect().sqlToQuery(query.getSQL()).sql
            )
            .digest("hex")
            .slice(0, 16)
        : ""
      try {
        const result = await execute(query)
        if (readTelemetry.hasSubscribers)
          readMeasurement({
            project: projectId,
            fingerprint,
            elapsedMs: performance.now() - started,
            rows: result.rows.length,
            bytes: Buffer.byteLength(JSON.stringify(result.rows)),
            outcome: "ok",
          })
        return result
      } catch (error) {
        readMeasurement({
          project: projectId,
          fingerprint,
          elapsedMs: performance.now() - started,
          rows: 0,
          bytes: 0,
          outcome: "error",
        })
        throw error
      }
    }
    const snapshot = Object.assign(snapshotDatabase, {
      projectId,
      execute: boundedExecute,
    }) as SemanticReadTransaction
    return { asOf: new Date(), client, snapshot, releaseAdmission }
  } catch (error) {
    let rollbackFailure: Error | undefined
    try {
      if (opened) await client.query("ROLLBACK")
    } catch (cleanupError) {
      rollbackFailure = asSnapshotError(cleanupError)
    } finally {
      // A client whose rollback failed may still have an open transaction.
      // Tell pg to discard it instead of returning it to the shared pool.
      client.release(rollbackFailure)
      releaseAdmission()
    }
    throw error
  }
}

async function closeSemanticReadSnapshot(
  resource: OpenSemanticReadSnapshot
): Promise<void> {
  try {
    // Read snapshots never commit. Rollback is safe after both successful
    // execution and failures, and releases the repeatable-read view.
    await resource.client.query("ROLLBACK")
    resource.client.release()
  } catch (error) {
    // Never return a possibly transactional client after failed cleanup.
    resource.client.release(asSnapshotError(error))
    throw error
  } finally {
    resource.releaseAdmission()
  }
}

/**
 * The dedicated PG connection remains open for every model read. It starts as
 * a READ ONLY REPEATABLE READ transaction and is always rolled back/released.
 */
export function withSemanticReadSnapshotEffect<Value, ErrorType, Requirements>(
  database: TracerDatabase,
  use: (
    snapshot: SemanticReadTransaction,
    asOf: Date
  ) => Effect.Effect<Value, ErrorType, Requirements>
): Effect.Effect<Value, ErrorType | Error, Requirements> {
  const clientFactory = resolveSnapshotClientFactory(database)
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openSemanticReadSnapshot(database, clientFactory),
      catch: asSnapshotError,
    }),
    (resource) => use(resource.snapshot, resource.asOf),
    (resource) =>
      Effect.tryPromise({
        try: () => closeSemanticReadSnapshot(resource),
        catch: asSnapshotError,
      })
  )
}

/** Promise bridge for the pure executor and direct tests. */
export function createSemanticSnapshotRunner(
  database: TracerDatabase
): SemanticSnapshotRunner {
  return (callback) =>
    Effect.runPromise(
      withSemanticReadSnapshotEffect(database, (snapshot, asOf) =>
        Effect.tryPromise({
          try: () => callback(snapshot, asOf),
          catch: asSnapshotError,
        })
      )
    )
}

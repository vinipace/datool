import { drizzle } from "drizzle-orm/node-postgres"
import type { QueryResult } from "pg"
import * as schema from "./schema"
import {
  getTracerProjectId,
  getTracerSnapshotClientFactory,
  registerTracerProjectId,
  scopedTracerTransaction,
  type TracerDatabase,
} from "./db"
import { ReadBudgetError } from "../semantic/read-budget"

/** Uses the analytics connection factory and a hard lifetime across all statements. */
export async function boundedReadTransaction<T>(
  database: TracerDatabase,
  deadline: number,
  work: (database: TracerDatabase) => Promise<T>
): Promise<T> {
  const factory = getTracerSnapshotClientFactory(database)
  if (!factory)
    throw new Error("A registered read connection factory is required.")
  const client = await factory()
  const original = client.query
  const query = original.bind(client) as (
    ...args: unknown[]
  ) => Promise<QueryResult>
  let timedOut = false,
    released = false,
    transactionClosed = false
  const timeout = () => {
    timedOut = true
    if (!released) {
      released = true
      client.query = original
      client.release(new Error("Read lifetime expired"))
    }
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    timeout()
    throw new ReadBudgetError(
      "READ_TIMEOUT",
      "The read exceeded its deadline while acquiring a connection."
    )
  }
  const timer = setTimeout(timeout, remaining)
  // Drizzle uses promise queries on this exclusively owned connection. Before
  // every statement, reduce PostgreSQL's own limit to the remaining lifetime.
  client.query = (async (...args: unknown[]) => {
    const text =
      typeof args[0] === "string"
        ? args[0]
        : String((args[0] as { text?: string })?.text ?? "")
    const control = /^\s*(begin|commit|rollback|savepoint|release)\b/i.test(
      text
    )
    if (!control) {
      const budget = deadline - Date.now()
      if (budget <= 0)
        throw new ReadBudgetError(
          "READ_TIMEOUT",
          "The read exceeded its deadline."
        )
      await query("select set_config('statement_timeout',$1,true)", [
        String(Math.min(10000, budget)),
      ])
    }
    const result = await query(...args)
    if (/^\s*(commit|rollback)\s*;?\s*$/i.test(text)) transactionClosed = true
    return result
  }) as typeof client.query
  try {
    const scoped = registerTracerProjectId(
      drizzle({ client, schema }),
      getTracerProjectId(database)
    )
    return await scoped.transaction(
      async (tx) => {
        await query("SET LOCAL lock_timeout = '2s'")
        await query("SET LOCAL idle_in_transaction_session_timeout = '15s'")
        return work(scopedTracerTransaction(scoped, tx))
      },
      { isolationLevel: "repeatable read", accessMode: "read only" }
    )
  } catch (error) {
    if (timedOut || Date.now() >= deadline)
      throw new ReadBudgetError(
        "READ_TIMEOUT",
        "The read exceeded its deadline."
      )
    throw error
  } finally {
    clearTimeout(timer)
    client.query = original
    if (!released) {
      released = true
      client.release(
        transactionClosed
          ? undefined
          : new Error("Read transaction cleanup did not complete")
      )
    }
  }
}

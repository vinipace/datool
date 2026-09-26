import { boundedReadTransaction } from "./read-transaction"
import { type SQL } from "drizzle-orm"
import {
  READ_MAX_BYTES,
  READ_BATCH_DEADLINE_MS,
  ReadBudgetError,
  withReadBudget,
} from "../semantic/read-budget"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { assertRelationBytes } from "./read-size"

export const CATALOG_LIMIT = 500

/** Small configuration catalogs fail explicitly instead of silently truncating. */
export function readCatalog<T>(
  database: TracerDatabase,
  relation: SQL,
  load: (database: TracerDatabase) => Promise<T[]>
): Promise<T[]> {
  const deadline = Date.now() + READ_BATCH_DEADLINE_MS
  return withReadBudget(getTracerProjectId(database), () =>
    boundedReadTransaction(database, deadline, async (tx) => {
      await assertRelationBytes(tx as unknown as TracerDatabase, relation)
      const rows = await load(tx)
      if (
        rows.length > CATALOG_LIMIT ||
        Buffer.byteLength(JSON.stringify(rows)) > READ_MAX_BYTES
      ) {
        throw new ReadBudgetError(
          "READ_RESULT_TOO_LARGE",
          "This configuration catalog exceeds 500 entries or 8 MiB. Use a specific resource ID."
        )
      }
      return rows
    })
  )
}

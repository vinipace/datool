import { sql, type SQL } from "drizzle-orm"
import type { TracerDatabase } from "./db"
import { ReadBudgetError, READ_MAX_BYTES } from "../semantic/read-budget"

/** Preflight in PostgreSQL before materializing complete evidence in the app. */
export async function assertRelationBytes(
  database: Pick<TracerDatabase, "execute">,
  relation: SQL
) {
  const result = await database.execute(
    sql`select coalesce(sum(octet_length(row_to_json(records)::text)),0) as bytes from (${relation}) records`
  )
  if (Number(result.rows[0].bytes) > READ_MAX_BYTES)
    throw new ReadBudgetError(
      "READ_RESULT_TOO_LARGE",
      "Complete evidence exceeds 8 MiB. Use paged reads or a bounded export job."
    )
}

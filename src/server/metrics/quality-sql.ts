import { sql, type SQL } from "drizzle-orm"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"

/** Diagnostics return scalar counts, including malformed rows outside the valid-time relation. */
export async function diagnosticWarnings(
  context: SemanticExecutionContext,
  relation: SQL,
  counts: Record<string, { predicate: SQL; message: string }>
) {
  const result = await context.snapshot.execute(
    sql`select ${sql.join(
      Object.entries(counts).map(
        ([key, item]) =>
          sql`count(*) filter(where ${item.predicate}) as ${sql.identifier(key)}`
      ),
      sql`, `
    )} from (${relation}) diagnostics`
  )
  const row = result.rows[0] as Record<string, string>
  return Object.entries(counts).flatMap(([key, item]) =>
    Number(row[key]) ? [`${row[key]} ${item.message}`] : []
  )
}

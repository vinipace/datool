import { ReadBudgetError, READ_MAX_BYTES } from "./read-budget"
import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticDataRow } from "@/src/lib/semantic/result"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import { semanticSqlFilters, type SqlFilterField } from "./sql-filters"

/** Pages a grouped SQL relation before anything crosses the database boundary. */
export async function executeSqlPage(
  relation: SQL,
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext,
  numeric: readonly string[] = query.measures,
  diagnostics: readonly string[] = []
) {
  const having = semanticSqlFilters(
    query.having ?? [],
    Object.fromEntries(
      query.measures.map((member) => [
        member,
        {
          value: sql`${sql.identifier(member)}`,
          type: "number",
        } satisfies SqlFilterField,
      ])
    )
  )
  const order = sql.join(
    query.order.map(
      ([member, direction]) =>
        sql`${sql.identifier(member)} ${numeric.includes(member) ? sql`` : sql`collate "C"`} ${direction === "desc" ? sql`desc nulls last` : sql`asc nulls first`}`
    ),
    sql`, `
  )
  const result = await context.snapshot
    .execute(sql`with aggregated as materialized (${relation}),
    grouped as (select * from aggregated where ${having}),
    page as (select * from grouped ${query.order.length ? sql`order by ${order}` : sql``} limit ${query.limit} offset ${query.offset})
    select case when (select coalesce(sum(octet_length(row_to_json(page)::text)),0) from page) <= ${READ_MAX_BYTES} then coalesce((select jsonb_agg((to_jsonb(page) - ARRAY[${sql.join(
      ["__unused", ...diagnostics].map((key) => sql`${key}::text`),
      sql`, `
    )}]) ${query.order.length ? sql`order by ${order}` : sql``}) from page), '[]'::jsonb) else null end as rows,
    ${query.total ? sql`(select count(*) from grouped)` : sql`null`} as total,
    ${
      diagnostics.length
        ? sql`(select jsonb_build_object(${sql.join(
            diagnostics.flatMap((key) => [
              sql`${key}::text`,
              sql`coalesce(sum(${sql.identifier(key)}),0)`,
            ]),
            sql`, `
          )}) from aggregated)`
        : sql`'{}'::jsonb`
    } as diagnostics`)
  const record = result.rows[0] as {
    rows: SemanticDataRow[]
    diagnostics: Record<string, number>
    total: string | null
  }
  if (record.rows === null)
    throw new ReadBudgetError(
      "READ_RESULT_TOO_LARGE",
      "The aggregate page exceeds 8 MiB. Request fewer groups."
    )
  const rows = record.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && numeric.includes(key) ? Number(value) : value,
      ])
    )
  )
  return {
    rows,
    diagnostics: record.diagnostics,
    paged: true as const,
    ...(query.total ? { total: Number(record.total) } : {}),
  }
}

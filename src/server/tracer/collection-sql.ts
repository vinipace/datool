import {
  ReadBudgetError,
  READ_MAX_BYTES,
  withReadBudget,
} from "../semantic/read-budget"
import { sql, type SQL } from "drizzle-orm"
import {
  parseFilterQuery,
  validateFilterFields,
  filterDate,
  fullTextFields,
} from "@/components/ui/datool/search-bar/filter-query"
import {
  collectionFilterFields,
  type FilterResource,
} from "@/src/lib/tracer/collection-filters"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { validation } from "./errors"
import { fullTextSqlFilter } from "../semantic/full-text-filter"

export function collectionSqlFilter(
  resource: FilterResource,
  expression: string | null | undefined,
  fields: Record<string, SqlFilterField>
) {
  try {
    const clauses = parseFilterQuery(expression ?? "")
    validateFilterFields(clauses, collectionFilterFields[resource])
    const predicates = clauses.map((clause) => {
      if ("text" in clause) {
        return fullTextSqlFilter(
          fullTextFields(collectionFilterFields[resource]).map(
            (field) => fields[field.id]
          ),
          clause.text
        )
      }
      const { path, operator, value } = clause
      return semanticSqlFilters(
        [
          {
            member: path[0],
            ...(path.length > 1 ? { path: path.slice(1) } : {}),
            operator: (
              {
                "=": "equals",
                "!=": "notEquals",
                ":":
                  typeof value === "string" && fields[path[0]].type !== "date"
                    ? "contains"
                    : "equals",
                ">": "gt",
                ">=": "gte",
                "<": "lt",
                "<=": "lte",
              } as const
            )[operator],
            values: [
              fields[path[0]].type === "date" && typeof value === "string"
                ? new Date(filterDate(value, Date.now())).toISOString()
                : value,
            ],
          },
        ],
        fields
      )
    })
    return predicates.length
      ? sql`(${sql.join(predicates, sql` and `)})`
      : sql`true`
  } catch (error) {
    throw validation(
      error instanceof Error ? error.message : "Invalid collection filter."
    )
  }
}

/** A scoped relation owns filter and projection; page/count share a database snapshot. */
export async function collectionSqlPage<T extends { id: string }>(
  database: TracerDatabase,
  relation: SQL,
  options: { cursor?: string | null; limit?: number; includeTotal?: boolean },
  time: string,
  ascending = false
) {
  const direction = ascending ? sql`asc` : sql`desc`
  const comparison = ascending ? sql`>` : sql`<`
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  return withReadBudget(getTracerProjectId(database), () =>
    database.transaction(
      async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`)
        const cursor = options.cursor
          ? sql`(select ${sql.identifier(time)} from scoped where id = ${options.cursor})`
          : undefined
        const result =
          await tx.execute(sql`with scoped as not materialized (${relation}), page as (
      select * from scoped ${cursor ? sql`where (${sql.identifier(time)},id) ${comparison} (${cursor},${options.cursor})` : sql``}
      order by ${sql.identifier(time)} ${direction}, id ${direction} limit ${limit + 1})
      select case when (select coalesce(sum(octet_length(row_to_json(page)::text)),0) from page) <= ${READ_MAX_BYTES} then coalesce((select jsonb_agg(to_jsonb(page) order by ${sql.identifier(time)} ${direction}, id ${direction}) from page),'[]'::jsonb) else null end as items,
      ${options.includeTotal ? sql`(select count(*) from scoped)` : sql`null`} as total,
      ${options.cursor ? sql`exists(select 1 from scoped where id = ${options.cursor})` : sql`true`} as valid`)
        const row = result.rows[0] as {
          items: T[]
          total: string
          valid: boolean
        }
        if (!row.valid)
          throw validation("cursor does not identify a row in this collection.")
        if (row.items === null)
          throw new ReadBudgetError(
            "READ_RESULT_TOO_LARGE",
            "This page exceeds 8 MiB. Request fewer rows."
          )
        const items = row.items.slice(0, limit)
        return {
          items,
          ...(options.includeTotal ? { total: Number(row.total) } : {}),
          nextCursor: row.items.length > limit ? items.at(-1)!.id : null,
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" }
    )
  )
}

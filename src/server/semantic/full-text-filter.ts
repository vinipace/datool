import { sql, type SQL } from "drizzle-orm"
import { safeJson, type SqlFilterField } from "./sql-filters"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"

export function fullTextSqlField(
  fields: SqlFilterField[],
  matchRelated?: (text: string) => SQL
): SqlFilterField {
  return {
    value: sql`null`,
    type: "string",
    predicate: (filter) => {
      const values = filter.values ?? []
      if (
        filter.operator !== "contains" ||
        !values.length ||
        values.some((value) => typeof value !== "string")
      ) {
        throw new SemanticModelQueryError(
          "MODEL_QUERY_INVALID",
          "Full-text search requires text values with contains."
        )
      }
      return sql`(${sql.join(
        values.map((value) => {
          const text = value as string
          const match = fullTextSqlFilter(fields, text)
          return matchRelated ? sql`(${match} or ${matchRelated(text)})` : match
        }),
        sql` or `
      )})`
    },
  }
}

/** Literal, case-insensitive text matching; JSON searches decoded string values. */
export function fullTextSqlFilter(fields: SqlFilterField[], text: string): SQL {
  const matches = fields.map((field) => {
    if (field.type === "json") {
      const document = field.nativeJson ? field.value : safeJson(field.value)
      return sql`exists (
        select 1 from jsonb_path_query(${document}, 'strict $.** ? (@.type() == "string")') as search(value)
        where strpos(lower(search.value #>> '{}'), lower(${text})) > 0
      )`
    }
    return sql`strpos(lower(${field.value}), lower(${text})) > 0`
  })
  return matches.length ? sql`(${sql.join(matches, sql` or `)})` : sql`false`
}

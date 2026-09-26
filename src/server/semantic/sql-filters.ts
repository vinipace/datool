import { sql, type SQL } from "drizzle-orm"
import type {
  SemanticFilter,
  SemanticFilterCondition,
} from "@/src/lib/semantic/query"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"

export type SqlFilterField = {
  /** Model-owned predicates for relationships that cannot be scalar columns. */
  predicate?: (filter: SemanticFilterCondition) => SQL
  nativeJson?: boolean
  value: SQL
  type: "string" | "number" | "date" | "json"
  /** Indexed epoch milliseconds for date comparisons, when persisted. */
  instant?: SQL
  caseSensitive?: boolean
  nullMatches?: boolean
}
export const safeJson = (value: SQL) =>
  sql`case when pg_input_is_valid((${value})::text, 'jsonb') then (${value})::text::jsonb else '{}'::jsonb end`
export const instantMs = (value: SQL) =>
  sql`case when pg_input_is_valid((${value})::text, 'timestamp with time zone') then trunc(extract(epoch from (${value})::timestamptz) * 1000)::double precision end`

/** Values and path segments are parameters. Only catalog-owned SQL can name columns. */
export function semanticSqlFilters(
  filters: readonly SemanticFilter[],
  fields: Record<string, SqlFilterField>
): SQL {
  const condition = (filter: SemanticFilterCondition): SQL => {
    const field = fields[filter.member]
    if (!field)
      throw new SemanticModelQueryError(
        "MODEL_QUERY_INVALID",
        `Unsupported filter member '${filter.member}'.`
      )
    if (field.predicate) return field.predicate(filter)
    if (filter.path && field.type !== "json")
      throw new SemanticModelQueryError(
        "MODEL_QUERY_INVALID",
        "Paths require a JSON field."
      )
    let value = field.value
    let kind: SQL = sql`${field.type === "number" ? "real" : "text"}`
    let exists: SQL = sql`true`
    if (field.type === "json") {
      let doc = field.nativeJson ? value : safeJson(value)
      for (const segment of filter.path ?? []) {
        doc = sql`${doc} #> ARRAY[${segment}::text]`
      }
      kind = sql`case jsonb_typeof(${doc}) when 'string' then 'text' when 'number' then 'real' when 'boolean' then (${doc})::text else jsonb_typeof(${doc}) end`
      value = sql`(${doc} #>> '{}')`
      exists = sql`${doc} is not null`
    } else {
      kind = sql`case when ${value} is null then 'null' else ${field.type === "number" ? "real" : "text"} end`
    }
    if (filter.operator === "set") return sql`(${exists} and ${kind} != 'null')`
    if (filter.operator === "notSet")
      return sql`(not (${exists}) or ${kind} = 'null')`
    const compare = (
      expected: NonNullable<SemanticFilterCondition["values"]>[number]
    ): SQL => {
      // Native JSONB containment can use the GIN index. Preserve scalar types;
      // array paths and null/missing semantics use the general expression below.
      if (
        field.nativeJson &&
        field.type === "json" &&
        expected !== null &&
        ["equals", "in"].includes(filter.operator) &&
        filter.path?.length &&
        filter.path.every((segment) => !/^\d+$/.test(segment))
      ) {
        const object = [...filter.path]
          .reverse()
          .reduce<unknown>((value, key) => ({ [key]: value }), expected)
        return sql`(${field.value} @> ${JSON.stringify(object)}::jsonb and ${kind} = ${typeof expected === "number" ? "real" : typeof expected === "boolean" ? String(expected) : "text"})`
      }
      const expectedKind = typeof expected
      const numeric = expectedKind === "number"
      let actual =
        numeric && field.type === "json"
          ? sql`case when ${kind} = 'real' then (${value})::numeric end`
          : value
      let bound: unknown = expected
      let typeMatch =
        expected === null
          ? sql`${kind} = 'null'`
          : numeric
            ? sql`${kind} in ('integer', 'real')`
            : expectedKind === "boolean"
              ? sql`${kind} = ${expected ? "true" : "false"}`
              : sql`${kind} = 'text'`
      if (field.type === "date" && expected !== null) {
        if (
          typeof expected !== "string" ||
          !Number.isFinite(Date.parse(expected))
        )
          throw new SemanticModelQueryError(
            "MODEL_QUERY_INVALID",
            "Date filters require an ISO date."
          )
        actual = field.instant ?? instantMs(value)
        bound = Date.parse(expected)
        typeMatch = sql`${actual} is not null`
      }
      const equal =
        expected === null
          ? typeMatch
          : sql`(${typeMatch} and ${actual} = ${typeof bound === "boolean" ? String(bound) : bound})`
      switch (filter.operator) {
        case "equals":
        case "in":
          return equal
        case "notEquals":
        case "notIn":
          return sql`not coalesce(${equal}, false)`
        case "contains":
        case "notContains":
        case "startsWith":
        case "endsWith": {
          if (typeof expected !== "string")
            throw new SemanticModelQueryError(
              "MODEL_QUERY_INVALID",
              "Text operators require strings."
            )
          const text = field.caseSensitive ? actual : sql`lower(${actual})`
          const needle = field.caseSensitive
            ? sql`${expected}`
            : sql`lower(${expected})`
          const match =
            filter.operator === "startsWith"
              ? sql`substr(${text}, 1, length(${expected})) = ${needle}`
              : filter.operator === "endsWith"
                ? sql`right(${text}, length(${expected})) = ${needle}`
                : sql`strpos(${text}, ${needle}) > 0`
          return sql`(${kind} = 'text' and ${filter.operator === "notContains" ? sql`not (${match})` : match})`
        }
        default: {
          if (!numeric && field.type !== "date")
            throw new SemanticModelQueryError(
              "MODEL_QUERY_INVALID",
              "Ordered comparisons require numbers or dates."
            )
          const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[
            filter.operator as "gt" | "gte" | "lt" | "lte"
          ]
          if (!op)
            throw new SemanticModelQueryError(
              "MODEL_QUERY_INVALID",
              "Unsupported operator."
            )
          return sql`(${typeMatch} and ${actual} ${sql.raw(op)} ${bound})`
        }
      }
    }
    const values = filter.values ?? []
    if (!values.length)
      throw new SemanticModelQueryError(
        "MODEL_QUERY_INVALID",
        "Filter values required."
      )
    const separator = ["notEquals", "notIn"].includes(filter.operator)
      ? sql` and `
      : sql` or `
    return sql`(${exists} and ${field.nullMatches === false ? sql`${value} is not null` : sql`true`} and (${sql.join(values.map(compare), separator)}))`
  }
  const visit = (filter: SemanticFilter): SQL =>
    "member" in filter
      ? condition(filter)
      : "and" in filter
        ? sql`(${sql.join(filter.and.map(visit), sql` and `)})`
        : sql`(${sql.join(filter.or.map(visit), sql` or `)})`
  return filters.length
    ? sql`(${sql.join(filters.map(visit), sql` and `)})`
    : sql`true`
}

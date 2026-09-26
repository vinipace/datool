import { sql, type SQL } from "drizzle-orm"
import { invocationSelectionSchema } from "@/src/lib/semantic/group-filter"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"

/** Saved membership, never current trace membership. EXISTS preserves the caller's grain. */
export function savedMembershipFields(
  model: string,
  project: string,
  run: SQL,
  target?: SQL
): Record<string, SqlFilterField> {
  const scope = sql`m.project_id=${project} and m.run_id=${run} ${target ? sql`and m.target_id=${target}` : sql``}`
  return {
    [`${model}.invocationGroup`]: {
      value: run,
      type: "string",
      predicate: (filter) => {
        if (
          !["equals", "in"].includes(filter.operator) ||
          !filter.values?.length ||
          filter.path
        )
          throw new SemanticModelQueryError(
            "MODEL_QUERY_INVALID",
            "Choose saved agent or workflow names and versions."
          )
        const values = filter.values.map((value) => {
          const parsed = invocationSelectionSchema.safeParse(
            (() => {
              try {
                return JSON.parse(String(value))
              } catch {
                return null
              }
            })()
          )
          if (!parsed.success)
            throw new SemanticModelQueryError(
              "MODEL_QUERY_INVALID",
              "Invalid saved operation selection."
            )
          const s = parsed.data
          return sql`(m.group_type=${s.type} and m.group_name=${s.name} ${
            s.versions
              ? sql`and (${sql.join(
                  s.versions.map(
                    (v) => sql`m.group_version is not distinct from ${v}::text`
                  ),
                  sql` or `
                )})`
              : sql``
          })`
        })
        return sql`exists(select 1 from eval_target_attributions m where ${scope} and (${sql.join(values, sql` or `)}))`
      },
    },
    ...Object.fromEntries(
      ["agent", "workflow", "containsModel"].map((key) => [
        `${model}.${key}`,
        {
          value: run,
          type: "string",
          predicate: (filter) => {
            const negative = {
              notEquals: "equals",
              notIn: "in",
              notContains: "contains",
              notSet: "set",
            } as const
            const positive = negative[filter.operator as keyof typeof negative]
            const field =
              key === "containsModel" ? sql`model.value` : sql`m.group_name`
            const matching = semanticSqlFilters(
              [{ ...filter, operator: positive ?? filter.operator }],
              {
                [filter.member]: {
                  value: field,
                  type: "string",
                  caseSensitive: true,
                },
              }
            )
            const exists = sql`exists(select 1 from eval_target_attributions m ${key === "containsModel" ? sql`cross join lateral jsonb_array_elements_text(m.models_json) model(value)` : sql``} where ${scope} ${key !== "containsModel" ? sql`and m.group_type=${key}` : sql``} and ${matching})`
            return positive ? sql`not (${exists})` : exists
          },
        } satisfies SqlFilterField,
      ])
    ),
  }
}

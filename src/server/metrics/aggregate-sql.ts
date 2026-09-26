import { sql, type SQL } from "drizzle-orm"
import type { NormalizedSemanticQuery } from "@/src/lib/semantic/query"
import type { SemanticExecutionContext } from "@/src/lib/semantic/model"
import { executeSqlPage } from "@/src/server/semantic/sql-page"
import { metricWindow } from "./common"
import { calendarBuckets } from "./logs-sql"

export function sqlDay(
  query: NormalizedSemanticQuery,
  member: string,
  timestamp: SQL
) {
  const window = metricWindow(query, member)
  return window.hasDayGrain
    ? sql`case ${sql.join(
        calendarBuckets(window).map(
          (b) =>
            sql`when ${timestamp} >= ${b.from} and ${timestamp} < ${b.to} then ${b.day}`
        ),
        sql` `
      )} end`
    : sql`null::text`
}

export async function aggregateSql(
  query: NormalizedSemanticQuery,
  context: SemanticExecutionContext,
  facts: SQL,
  timeMember: string,
  measures: Record<string, SQL>,
  numericDimensions: string[] = [],
  diagnostics: Record<
    string,
    { predicate: SQL; message: string; weight?: SQL }
  > = {},
  fillCalendar = false
) {
  const keys = [
    ...query.dimensions,
    ...(query.timeDimensions.some((t) => t.granularity) ? [timeMember] : []),
  ]
  const dimensions = [...query.dimensions, timeMember].map(
    (k) => sql`${sql.identifier(k)}`
  )
  const diagnosticEntries = Object.entries(diagnostics)
  const select = [
    ...diagnosticEntries.map(
      ([key, item]) =>
        sql`${item.weight ? sql`coalesce(sum(${item.weight}) filter(where ${item.predicate}),0)` : sql`count(*) filter(where ${item.predicate})`} as ${sql.identifier(`__diagnostic_${key}`)}`
    ),
    ...dimensions.map((d, i) =>
      !keys.includes([...query.dimensions, timeMember][i])
        ? sql`null::text as ${d}`
        : d
    ),
    ...query.measures.map(
      (m) => sql`${measures[m.split(".").at(-1)!]} as ${sql.identifier(m)}`
    ),
  ]
  const grouped = sql`with facts as (${facts}) select ${sql.join(select, sql`, `)} from facts
    ${
      keys.length
        ? sql`group by ${sql.join(
            keys.map((k) => sql`${sql.identifier(k)}`),
            sql`, `
          )}`
        : sql``
    }`
  const window = metricWindow(query, timeMember)
  const relation =
    fillCalendar && !query.dimensions.length && window.hasDayGrain
      ? sql`with grouped as (${grouped}), facts as (${facts}), empty as (
        select ${sql.join(
          query.measures.map(
            (m) =>
              sql`${measures[m.split(".").at(-1)!]} as ${sql.identifier(m)}`
          ),
          sql`, `
        )} from facts where false
      ), days(bucket) as (values ${sql.join(
        calendarBuckets(window).map((b) => sql`(${b.day}::text)`),
        sql`, `
      )})
      select days.bucket as ${sql.identifier(timeMember)},
        ${sql.join(
          query.measures.map(
            (m) =>
              sql`case when grouped.${sql.identifier(timeMember)} is null then empty.${sql.identifier(m)} else grouped.${sql.identifier(m)} end as ${sql.identifier(m)}`
          ),
          sql`, `
        )}
        ${
          diagnosticEntries.length
            ? sql`, ${sql.join(
                diagnosticEntries.map(
                  ([key]) =>
                    sql`coalesce(grouped.${sql.identifier(`__diagnostic_${key}`)},0) as ${sql.identifier(`__diagnostic_${key}`)}`
                ),
                sql`, `
              )}`
            : sql``
        }
      from days left join grouped on grouped.${sql.identifier(timeMember)}=days.bucket cross join empty`
      : grouped
  const page = await executeSqlPage(
    relation,
    query,
    context,
    [...query.measures, ...numericDimensions],
    diagnosticEntries.map(([key]) => `__diagnostic_${key}`)
  )
  return {
    ...page,
    warnings: diagnosticEntries.flatMap(([key, item]) => {
      const count = Number(page.diagnostics[`__diagnostic_${key}`])
      return count ? [`${count} ${item.message}`] : []
    }),
  }
}

export const countWhere = (predicate: SQL) =>
  sql`count(*) filter (where ${predicate})`
export const lifecycleMeasures = (statuses: string[]) =>
  Object.fromEntries(
    statuses.map((status) => [
      `${status}Count`,
      countWhere(sql`status = ${status}`),
    ])
  )

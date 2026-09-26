import { sql, type SQL } from "drizzle-orm"
import type { TracerDatabase } from "./db"
import { validation } from "./errors"
import { traces } from "./schema"

/** Reuse expensive text matches without materializing trace payloads. */
export async function traceSearchPageIds(
  database: Pick<TracerDatabase, "execute">,
  where: SQL,
  options: { limit: number; cursor?: string | null; includeTotal?: boolean }
) {
  const cursorTime = sql`(select started_at_ms from cursor_row)`
  const after = options.cursor
    ? sql`case when ${cursorTime} is null then
        (started_at_ms is null and id < ${options.cursor}) or started_at_ms is not null
      else (started_at_ms, id) < (${cursorTime}, ${options.cursor}) end`
    : sql`true`
  // A total already requires all matches. Without it, allow the page to stop early.
  const result = await database.execute<{
    ids: string[]
    total: string | null
    valid: boolean
  }>(sql`with matched as ${options.includeTotal ? sql`materialized` : sql`not materialized`} (
      select ${traces.id}, ${traces.startedAtMs} from ${traces} where ${where}
    ), cursor_row as (
      select started_at_ms from matched where id = ${options.cursor ?? null}
    ), page as (
      select id, started_at_ms from matched where ${after}
      order by started_at_ms desc, id desc limit ${options.limit + 1}
    )
    select array(select id from page order by started_at_ms desc, id desc) as ids,
      ${options.includeTotal ? sql`(select count(*) from matched)` : sql`null`} as total,
      ${options.cursor ? sql`exists(select 1 from cursor_row)` : sql`true`} as valid`)
  const row = result.rows[0]
  if (!row.valid)
    throw validation("cursor does not identify a row in this collection.")
  return {
    ids: row.ids,
    ...(options.includeTotal ? { total: Number(row.total) } : {}),
  }
}

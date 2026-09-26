import { test, expect } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { getTracerProjectId } from "@/src/server/tracer/db"

test("concurrent updates to one invocation bucket preserve committed counts and duration", async () => {
  const db = await createTracerFixture()
  const project = getTracerProjectId(db)
  try {
    await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        await db.execute(sql`insert into traces(project_id,id,name,operation,status,started_at,group_type,group_name)
        values(${project},${`concurrent-${i}`},'Hot group','test','running','2026-09-01T00:00:00Z','agent','Same agent')`)
        await db.execute(
          sql`update traces set status='completed',ended_at='2026-09-01T00:00:01Z' where project_id=${project} and id=${`concurrent-${i}`}`
        )
        if (i % 2 === 0)
          await db.execute(
            sql`delete from traces where project_id=${project} and id=${`concurrent-${i}`}`
          )
      })
    )
    const result = await db.execute(
      sql`select row_count,duration_count,duration_sum,status from invocation_hourly_stats where project_id=${project}`
    )
    expect(result.rows).toEqual([
      {
        row_count: "50",
        duration_count: "50",
        duration_sum: "50000",
        status: "completed",
      },
    ])
    const raw = await db.execute(
      sql`select count(*) as count from traces where project_id=${project}`
    )
    expect(raw.rows[0].count).toBe("50")
  } finally {
    await closeTracerFixture(db)
  }
}, 30_000)

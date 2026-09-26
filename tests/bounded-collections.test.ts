import { test, expect } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"

test("selective saved views and session summaries remain exact beyond 20k traces", async () => {
  const target = await createIsolatedPostgres()
  let database: ReturnType<typeof createTracerDatabase> | undefined
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const service = new TracerService(database)
    await database.execute(
      sql`insert into sessions(project_id,id,created_at,updated_at) values(${target.projectId},'large','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`
    )
    await database.execute(sql`insert into traces(project_id,id,session_id,name,operation,status,started_at,input_json)
      select ${target.projectId},'trace-'||lpad(i::text,6,'0'),'large','Trace','test','completed','2026-09-01T00:00:00Z',jsonb_build_object('selected',i>20000)::text from generate_series(1,20005) i`)
    const session = await runTracerEffect(service.getSession("large"))
    expect(session.traceCount).toBe(20005)
    expect(session.traces.length).toBe(50)
    expect(session.nextCursor).not.toBeNull()
    const view = await runTracerEffect(
      service.createSavedView({
        name: "Selected only",
        resource: "traces",
        columns: [
          {
            id: "selected",
            label: "Selected",
            format: "text",
            selector: "trace.input.selected",
          },
        ],
        filters: [
          { selector: "trace.input.selected", operator: "equals", value: true },
        ],
      })
    )
    const first = await runTracerEffect(
      service.getSavedViewData(view.id, { limit: 2 })
    )
    expect(first.total).toBe(5)
    expect(first.rows.map((row) => row.id)).toEqual([
      "trace-020001",
      "trace-020002",
    ])
    const empty = await runTracerEffect(
      service.getSavedViewData(view.id, { limit: 2, offset: 6 })
    )
    expect(empty.rows.length).toBe(0)
    expect(empty.total).toBe(5)
    const traces = await runTracerEffect(
      service.listTraces({ limit: 2, sessionId: "large", includeTotal: true })
    )
    expect(traces.items.length).toBe(2)
    expect(traces.total).toBe(20005)
  } finally {
    if (database) await closeTracerDatabase(database)
    await target.close()
  }
})

test("focused span ancestry includes ancestors outside the first trace page", async () => {
  const target = await createIsolatedPostgres()
  let database: ReturnType<typeof createTracerDatabase> | undefined
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    await database.execute(
      sql`insert into traces(project_id,id,name,operation,status,started_at) values(${target.projectId},'trace','Trace','test','completed','2026-09-01T00:00:00Z')`
    )
    await database.execute(sql`insert into spans(project_id,id,trace_id,parent_id,name,kind,status,started_at)
      select ${target.projectId},'span-'||lpad(i::text,3,'0'),'trace',case when i=150 then 'span-149' end,'Span','custom','completed','2026-09-01T00:00:00Z' from generate_series(1,150)i`)
    const service = new TracerService(database)
    const trace = await runTracerEffect(service.getTrace("trace"))
    expect(trace.spans.length).toBe(100)
    expect(trace.spans.some((span) => span.id === "span-150")).toBe(false)
    const path = await runTracerEffect(
      service.getTraceSpanPath("trace", "span-150")
    )
    expect(path.map((span) => span.id)).toEqual(["span-149", "span-150"])
    const error = await runTracerEffect(
      service.getTraceSpanPath("other", "span-150")
    ).then(
      () => null,
      (error) => error
    )
    expect(error).toMatchObject({ code: "NOT_FOUND" })
  } finally {
    if (database) await closeTracerDatabase(database)
    await target.close()
  }
})

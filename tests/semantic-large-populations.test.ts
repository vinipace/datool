import { readTelemetry } from "@/src/server/semantic/telemetry"
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

test("all six semantic models aggregate complete populations beyond 20000 facts", async () => {
  const statements: { rows: number; bytes: number; projectHash: string }[] = []
  const observe = (event: unknown) =>
    statements.push(event as (typeof statements)[number])
  readTelemetry.subscribe(observe)
  const target = await createIsolatedPostgres()
  let database: ReturnType<typeof createTracerDatabase> | undefined
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const project = target.projectId
    await database.execute(sql`insert into traces(project_id,id,name,operation,status,started_at,ended_at,group_type,group_name)
      select ${project},'trace-'||i,'Trace','large','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','workflow','Workflow' from generate_series(1,20001)i`)
    await database.execute(sql`insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,group_type,group_name)
      select ${project},'span-'||i,'trace-'||i,'Agent','agent','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','agent','Agent' from generate_series(1,20001)i`)
    await database.execute(
      sql`insert into evaluators(project_id,id,name,created_at,updated_at) values(${project},'e','Evaluator','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`
    )
    await database.execute(
      sql`insert into evaluator_versions(project_id,id,evaluator_id,version,language,code,created_at) values(${project},'v','e',1,'javascript','return 1','2026-09-01T00:00:00Z')`
    )
    await database.execute(sql`insert into eval_runs(project_id,id,status,created_at)
      select ${project},'run-'||i,'completed','2026-09-01T00:00:00Z' from generate_series(1,20001)i`)
    await database.execute(sql`insert into eval_results(project_id,id,run_id,trace_id,evaluator_id,evaluator_version_id,status,created_at,completed_at)
      select ${project},'result-'||i,'run-'||i,'trace-'||i,'e','v','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z' from generate_series(1,20001)i`)
    const service = new TracerService(database)
    for (const [measure, time] of [
      ["logs.spanCount", "logs.startedAt"],
      ["traces.count", "traces.startedAt"],
      ["evalRuns.count", "evalRuns.createdAt"],
      ["scores.executionCount", "scores.completedAt"],
      ["agents.count", "agents.startedAt"],
      ["workflows.count", "workflows.startedAt"],
    ]) {
      const before = statements.length
      const result = await runTracerEffect(
        service.querySemanticMetrics({
          measures: [measure],
          timeDimensions: [
            {
              dimension: time,
              dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
            },
          ],
          limit: 1,
          total: true,
        })
      )
      expect(result.data.length).toBe(1)
      expect(result.data[0][measure]).toBe(20001)
      expect(result.meta.page.total).toBe(1)
      const reads = statements.slice(before)
      expect(reads.length > 0 && reads.length <= 4).toBe(true)
      expect(
        reads.every((read) => read.rows <= 1 && read.bytes < 100_000)
      ).toBe(true)
      expect(reads.every((read) => read.projectHash !== project)).toBe(true)
    }
  } finally {
    readTelemetry.unsubscribe(observe)
    if (database) await closeTracerDatabase(database)
    await target.close()
  }
}, 30_000)

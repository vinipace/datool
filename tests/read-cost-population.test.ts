import { test, expect } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { getTracerProjectId } from "@/src/server/tracer/db"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { semanticCatalog } from "@/src/server/metrics/registry"

test("unreported workflow and agent costs traverse complete populations without double counting", async () => {
  const db = await createTracerFixture()
  try {
    const project = getTracerProjectId(db)
    await db.execute(sql`insert into traces(project_id,id,name,operation,status,started_at,ended_at,group_type,group_name)
      select ${project},'cost-trace-'||i,'Workflow','test','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','workflow','Flow '||(i%100) from generate_series(1,25001)i`)
    await db.execute(sql`insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,group_type,group_name)
      select ${project},'agent-'||i,'cost-trace-'||i,'Agent','agent','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','agent','Agent '||(i%100) from generate_series(1,25001)i`)
    await db.execute(sql`insert into spans(project_id,id,trace_id,parent_id,name,kind,status,started_at,ended_at,attributes_json)
      select ${project},'model-'||i,'cost-trace-'||i,'agent-'||i,'Model','llm','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','{"cost.usd":0.01}' from generate_series(1,25001)i`)
    await db.execute(sql`analyze traces`)
    await db.execute(sql`analyze spans`)
    for (const model of ["agents", "workflows"]) {
      const result = await executeSemanticQuery(
        {
          measures: [
            `${model}.count`,
            `${model}.reportedCostUsd`,
            `${model}.completeCostCount`,
            `${model}.p95DurationMs`,
          ],
          timeDimensions: [
            {
              dimension: `${model}.startedAt`,
              dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
            },
          ],
        },
        {
          catalog: semanticCatalog,
          requestId: "descendant-cost-population",
          snapshotRunner: createSemanticSnapshotRunner(db),
        }
      )
      expect(result.data[0][`${model}.count`]).toBe(25001)
      expect(result.data[0][`${model}.completeCostCount`]).toBe(25001)
      expect(
        Math.abs(Number(result.data[0][`${model}.reportedCostUsd`]) - 250.01) <
          0.000001
      ).toBe(true)
      expect(result.data[0][`${model}.p95DurationMs`]).toBe(1000)
      expect(result.meta.quality.status).toBe("complete")
    }
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)

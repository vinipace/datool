import { test, expect } from "bun:test"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { evalRuns, evalRunTargets, traces } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import type { TraceForEvaluation } from "@/src/lib/tracer/contracts"

test("comparison matches the complete population before paging and leaves duplicate inputs unmatched", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const service = new TracerService(database),
    time = "2026-09-01T00:00:00Z"
  try {
    await database.insert(evalRuns).values(
      ["left", "right"].map((id) => ({
        id,
        projectId: target.projectId,
        status: "completed",
        createdAt: time,
      }))
    )
    for (const side of ["left", "right"]) {
      const rows = Array.from({ length: 122 }, (_, i) => ({
        id: `${side}-${i}`,
        projectId: target.projectId,
        name: `Row ${i}`,
        operation: "comparison",
        status: "completed",
        startedAt: time,
        inputJson: JSON.stringify({ key: i < 120 ? i : "duplicate" }),
      }))
      await database.insert(traces).values(rows)
      await database.insert(evalRunTargets).values(
        rows.map((trace, i) => ({
          id: `target-${trace.id}`,
          projectId: target.projectId,
          runId: side,
          traceId: trace.id,
          ordinal: side === "left" ? i : 121 - i,
          createdAt: time,
          snapshotJson: JSON.stringify({
            trace: {
              id: trace.id,
              name: trace.name,
              operation: trace.operation,
              status: "completed",
              startedAt: time,
              endedAt: time,
              sessionId: null,
              input: JSON.parse(trace.inputJson),
              output: null,
              attributes: {},
              spans: [],
            } satisfies TraceForEvaluation,
            datasetItem: null,
          }),
        }))
      )
    }
    const first = await runTracerEffect(
      service.compareEvalRuns("left", "right")
    )
    expect(first.total).toBe(124)
    expect(first.pairs.length).toBe(50)
    expect(first.pairs[0].left?.id).toBe("target-left-0")
    expect(first.pairs[0].right?.id).toBe("target-right-0")
    expect(first.pairs[0].matchedBy).toBe("input")
    const end = await runTracerEffect(
      service.compareEvalRuns("left", "right", 120)
    )
    expect(end.pairs.length).toBe(4)
    expect(end.pairs.every((pair) => !(pair.left && pair.right))).toBe(true)
    const detail = await runTracerEffect(
      service.getEvalRun("left", { limit: 10 })
    )
    expect(detail.rows?.length).toBe(10)
    expect(detail.targetCount).toBe(122)
    expect(detail.nextCursor).toBe("target-left-9")
  } finally {
    await closeTracerDatabase(database)
    await target.close()
  }
})

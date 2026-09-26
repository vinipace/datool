import { expect, test } from "bun:test"
import {
  parseSemanticQuery,
  semanticQuerySchema,
  type SemanticQueryInput,
} from "@/src/lib/semantic/query"
import { validateSemanticQuery } from "@/src/server/semantic/executor"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { spans, traces } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

const threshold = {
  member: "traces.erroredCount",
  operator: "gt" as const,
  values: [1],
}
const base: SemanticQueryInput = {
  measures: ["traces.count"],
  dimensions: ["traces.operation"],
  timeDimensions: [
    {
      dimension: "traces.startedAt",
      dateRange: ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"],
    },
  ],
  having: [threshold],
  order: [["traces.operation", "asc"]],
  total: true,
  limit: 1,
}

test("measure thresholds validate their type, model, operator and computation budget", () => {
  expect(parseSemanticQuery(base).having).toEqual([threshold])
  for (const filter of [
    { ...threshold, values: ["1"] },
    { ...threshold, values: [1, 2] },
    { ...threshold, values: [Infinity] },
    { ...threshold, operator: "contains" },
    { ...threshold, path: ["count"] },
    { ...threshold, member: "logs.spanCount" },
  ])
    expect(
      semanticQuerySchema.safeParse({ ...base, having: [filter] }).success
    ).toBe(false)
  expect(() =>
    validateSemanticQuery(
      { ...base, having: [{ ...threshold, member: "traces.operation" }] },
      semanticCatalog
    )
  ).toThrow("expected a measure")
  expect(() =>
    validateSemanticQuery(
      { ...base, having: [{ ...threshold, member: "traces.missing" }] },
      semanticCatalog
    )
  ).toThrow("not available")
  expect(
    semanticQuerySchema.safeParse({
      ...base,
      measures: Array.from({ length: 50 }, (_, i) => `traces.m${i}`),
    }).success
  ).toBe(false)
})

test("aggregate thresholds filter groups before pagination and persist across dashboards", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const service = new TracerService(db)
  const query = (value: SemanticQueryInput) =>
    runTracerEffect(service.querySemanticMetrics(value))
  try {
    for (const [operation, statuses] of Object.entries({
      a: ["completed", "completed"],
      b: ["errored", "errored", "completed", "completed"],
      c: ["errored", "errored", "errored", "completed", "completed"],
      d: ["errored"],
    })) {
      for (const [index, status] of statuses.entries()) {
        const id = `${operation}-${index}`
        const common = {
          projectId: target.projectId,
          status,
          startedAt: "2026-09-01T12:00:00Z",
          endedAt: "2026-09-01T12:00:02Z",
        }
        await db
          .insert(traces)
          .values({
            ...common,
            id,
            name: operation,
            operation,
            groupType: "workflow",
            groupName: operation,
          })
        await db
          .insert(spans)
          .values({
            ...common,
            id: `${id}-span`,
            traceId: id,
            name: operation,
            kind: "llm",
            groupType: "agent",
            groupName: operation,
            attributesJson: JSON.stringify({ "cost.usd": 1 }),
          })
      }
    }
    const first = await query(base)
    expect(
      first.data.map((row) => [row["traces.operation"], row["traces.count"]])
    ).toEqual([["b", 4]])
    expect(first.meta.page.total).toBe(2)
    expect(first.data[0]["traces.erroredCount"]).toBeUndefined()
    expect(first.annotation.measures["traces.erroredCount"]).toBeUndefined()
    expect(
      (await query({ ...base, offset: 1 })).data[0]["traces.operation"]
    ).toBe("c")
    const beyond = await query({ ...base, offset: 2 })
    expect(beyond.data).toEqual([])
    expect(beyond.meta.page.total).toBe(2)
    for (const [operator, expected] of [
      ["gt", 2],
      ["gte", 3],
      ["lt", 1],
      ["lte", 2],
      ["equals", 1],
      ["notEquals", 3],
    ] as const) {
      expect(
        (
          await query({
            ...base,
            having: [{ ...threshold, operator }],
            limit: 100,
          })
        ).meta.page.total
      ).toBe(expected)
    }
    const narrowed = await query({
      ...base,
      filters: [
        { member: "traces.operation", operator: "equals", values: ["c"] },
      ],
    })
    expect(narrowed.meta.page.total).toBe(1)
    expect(narrowed.data[0]["traces.count"]).toBe(5)
    const perTrace = {
      ...base,
      dimensions: ["traces.trace"],
      order: [],
      limit: 100,
    }
    expect((await query(perTrace)).data).toEqual([])
    expect(
      (await query({ ...perTrace, having: [{ ...threshold, values: [0] }] }))
        .meta.page.total
    ).toBe(6)
    const scalar = { ...base, dimensions: [], order: [] }
    expect((await query(scalar)).data[0]["traces.count"]).toBe(12)
    const excluded = await query({
      ...scalar,
      having: [{ ...threshold, values: [6] }],
    })
    expect(excluded.data).toEqual([])
    expect(excluded.meta.page.total).toBe(0)
    for (const model of ["agents", "workflows"]) {
      const result = await query({
        ...base,
        measures: [`${model}.count`],
        dimensions: [`${model}.name`],
        timeDimensions: base.timeDimensions!.map((time) => ({
          ...time,
          dimension: `${model}.startedAt`,
        })),
        having: [{ ...threshold, member: `${model}.erroredCount` }],
        order: [[`${model}.name`, "asc"]],
      })
      expect(result.data[0][`${model}.name`]).toBe("b")
      expect(result.meta.page.total).toBe(2)
    }
    const logs: SemanticQueryInput = {
      measures: ["logs.costUsd"],
      timeDimensions: [
        { ...base.timeDimensions![0], dimension: "logs.startedAt" },
      ],
      having: [{ member: "logs.p95LatencyMs", operator: "gt", values: [2000] }],
      total: true,
    }
    expect((await query(logs)).data).toEqual([])
    expect(
      (
        await query({
          ...logs,
          having: [{ ...logs.having![0], operator: "gte" }],
        })
      ).data[0]["logs.costUsd"]
    ).toBe(12)
    const emptyDay = await query({
      ...logs,
      measures: ["logs.spanCount"],
      timeDimensions: [{ ...logs.timeDimensions![0], granularity: "day" }],
      having: [{ member: "logs.spanCount", operator: "equals", values: [0] }],
    })
    expect(emptyDay.data).toEqual([
      { "logs.startedAt": "2026-09-02", "logs.spanCount": 0 },
    ])
    const saved = await runTracerEffect(
      service.dashboards.create({
        schemaVersion: 1,
        name: "Error thresholds",
        description: "",
        widgets: [
          {
            id: "errors",
            title: "Errors",
            type: "table",
            width: 1,
            query: base,
          },
        ],
      })
    )
    const reloaded = await runTracerEffect(service.dashboards.get(saved.id))
    expect(reloaded.widgets[0].query.having).toEqual([threshold])
    const preview = await runTracerEffect(
      service.agent.previewDashboard(saved.id)
    )
    expect(preview.results[0].data[0]["traces.operation"]).toBe("b")
    expect(preview.results[0].meta.page.total).toBe(2)
  } finally {
    await closeTracerDatabase(db)
    await target.close()
  }
}, 30000)

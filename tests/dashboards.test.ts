import { scopeRows } from "./helpers/tracer-fixture"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import { closeTracerDatabase } from "../src/server/tracer/db"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { createDashboardService } from "@/src/server/tracer/dashboards"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import {
  dashboardInputSchema,
  newDashboardWidget,
  dashboardColumns,
  expandLegacyDashboardGrouping,
  dashboardWidgetSchema,
} from "@/src/lib/tracer/dashboards"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { traces } from "@/src/server/tracer/schema"

const model = semanticCatalog
  .metadata()
  .models.find((m) => m.name === "traces")!
const widget = newDashboardWidget(model, new Date("2026-09-07T12:00:00Z"))
const input = {
  schemaVersion: 1 as const,
  name: "Trace health",
  description: "Persisted trace metrics",
  widgets: [widget],
}
async function rejected(promise: Promise<unknown>, message: string) {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain(message)
}
test("rejects incompatible visualizations and duplicate IDs", () => {
  expect(
    dashboardInputSchema.safeParse({
      ...input,
      widgets: [
        {
          ...widget,
          query: { ...widget.query, dimensions: ["traces.status"] },
        },
      ],
    }).success
  ).toBe(false)
  expect(
    dashboardInputSchema.safeParse({
      ...input,
      widgets: [{ ...widget, type: "bar" }],
    }).success
  ).toBe(false)
  expect(
    dashboardInputSchema.safeParse({ ...input, widgets: [widget, widget] })
      .success
  ).toBe(false)
  expect(
    dashboardInputSchema.safeParse({
      ...input,
      widgets: [{ ...widget, query: { ...widget.query, timeDimensions: [] } }],
    }).success
  ).toBe(false)
})

test("category charts require one measure and support multiple groupings", () => {
  const donut = {
    ...widget,
    type: "donut",
    query: { ...widget.query, dimensions: ["traces.status"] },
  }
  const valid = (value: unknown) =>
    dashboardInputSchema.safeParse({ ...input, widgets: [value] }).success
  expect(valid(donut)).toBe(true)
  expect(valid({ ...donut, query: { ...donut.query, dimensions: [] } })).toBe(
    false
  )
  expect(
    valid({
      ...donut,
      query: {
        ...donut.query,
        dimensions: ["traces.status", "traces.traceName"],
      },
    })
  ).toBe(true)
  expect(
    valid({
      ...donut,
      type: "bar",
      query: {
        ...donut.query,
        dimensions: ["traces.status", "traces.traceName"],
      },
    })
  ).toBe(true)
  expect(
    valid({
      ...donut,
      query: {
        ...donut.query,
        measures: ["traces.count", "traces.erroredCount"],
      },
    })
  ).toBe(false)
})

test("editing legacy composite groupings expands fields and ordering without dropping scope", () => {
  const legacy = dashboardWidgetSchema.parse({
    ...widget,
    type: "bar",
    query: {
      ...widget.query,
      measures: ["evalQuality.meanScore"],
      timeDimensions: widget.query.timeDimensions.map((time) => ({
        ...time,
        dimension: "evalQuality.completedAt",
      })),
      dimensions: ["evalQuality.groupModel", "evalQuality.model"],
      order: [
        ["evalQuality.groupModel", "asc"],
        ["evalQuality.model", "desc"],
      ],
      filters: [
        {
          member: "evalQuality.workflow",
          operator: "equals",
          values: ["Support"],
        },
      ],
    },
  })
  const expanded = expandLegacyDashboardGrouping(legacy)
  expect(expanded.query.dimensions).toEqual([
    "evalQuality.groupName",
    "evalQuality.model",
  ])
  expect(expanded.query.order).toEqual([
    ["evalQuality.groupName", "asc"],
    ["evalQuality.model", "asc"],
  ])
  expect(expanded.query.filters).toEqual(legacy.query.filters)
  expect(expanded.query.timeDimensions).toEqual(legacy.query.timeDimensions)
  expect(legacy.query.dimensions[0]).toBe("evalQuality.groupModel")
  expect(expandLegacyDashboardGrouping(expanded)).toBe(expanded)
  expect(dashboardWidgetSchema.safeParse(expanded).success).toBe(true)
})

test("multiple grouping fields persist and aggregate each tuple independently", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        ["chat", "chat", "extract"].map((operation, index) => ({
          id: `multi-group-${index}`,
          name: "Shared workflow",
          operation,
          status: "completed",
          startedAt: "2026-09-06T12:00:00Z",
        }))
      )
    )
    const service = createDashboardService(db)
    const created = await run(
      service.create({
        ...input,
        widgets: [
          {
            ...widget,
            type: "bar",
            query: {
              ...widget.query,
              measures: ["traces.count"],
              dimensions: ["traces.traceName", "traces.operation"],
              order: [["traces.operation", "asc"]],
            },
          },
        ],
      })
    )
    const saved = await run(service.get(created.id))
    expect(
      dashboardWidgetSchema.parse(saved.widgets[0]).query.dimensions
    ).toEqual(["traces.traceName", "traces.operation"])
    const result = await executeSemanticQuery(
      dashboardWidgetSchema.parse(saved.widgets[0]).query,
      {
        catalog: semanticCatalog,
        requestId: "multi-group",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(
      result.data.map((row) => [
        row["traces.traceName"],
        row["traces.operation"],
        row["traces.count"],
      ])
    ).toEqual([
      ["Shared workflow", "chat", 2],
      ["Shared workflow", "extract", 1],
    ])
    expect(result.meta.page.total).toBe(2)
  } finally {
    await closeTracerFixture(db)
  }
})
test("persists validated dashboards, executes saved queries, and prevents stale writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-dashboards-"))
  const db = await createTracerFixture()
  let second: ReturnType<typeof createTracerDatabase> | undefined
  try {
    const service = createDashboardService(db)
    await rejected(
      run(
        service.create({
          ...input,
          widgets: [
            {
              ...widget,
              query: { ...widget.query, measures: ["traces.unknown"] },
            },
          ],
        })
      ),
      "not available"
    )
    await rejected(
      run(
        service.create({
          ...input,
          widgets: [
            {
              ...widget,
              type: "table",
              query: {
                ...widget.query,
                dimensions: ["traces.parent.sessionId"],
              },
            },
          ],
        })
      ),
      "filter-only"
    )
    const created = await run(service.create(input))
    second = reopenTracerFixture(db)
    expect(await run(createDashboardService(second).get(created.id))).toEqual(
      created
    )
    const updated = await run(
      service.update(created.id, {
        config: { ...input, name: "Updated dashboard" },
        expectedRevision: 1,
      })
    )
    expect(updated.revision).toBe(2)
    await rejected(
      run(service.update(created.id, { config: input, expectedRevision: 1 })),
      "changed"
    )
    await rejected(run(service.delete(created.id, 1)), "changed")
    await db.insert(traces).values(
      scopeRows(db, {
        id: "dash-test-trace",
        name: "Dashboard test",
        operation: "chat",
        status: "completed",
        startedAt: "2026-09-06T12:00:00Z",
        endedAt: "2026-09-06T12:00:01Z",
        inputJson: "{}",
        outputJson: "{}",
        attributesJson: "{}",
      })
    )
    const result = await executeSemanticQuery(
      dashboardWidgetSchema.parse(updated.widgets[0]).query,
      {
        catalog: semanticCatalog,
        requestId: "dashboard-test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(result.data[0][widget.query.measures[0]]).toBe(1)
    const table = {
      ...widget,
      type: "table" as const,
      query: {
        ...widget.query,
        measures: ["traces.count"],
        dimensions: ["traces.operation"],
      },
    }
    const savedTable = await run(service.create({ ...input, widgets: [table] }))
    const tableResult = await executeSemanticQuery(
      dashboardWidgetSchema.parse(savedTable.widgets[0]).query,
      {
        catalog: semanticCatalog,
        requestId: "dashboard-table",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(tableResult.data[0]["traces.operation"]).toBe("chat")
    expect(tableResult.data[0]["traces.count"]).toBe(1)
    expect(dashboardColumns(tableResult.query)).toEqual([
      "traces.operation",
      "traces.count",
    ])
    await run(service.delete(created.id, 2))
    expect((await run(service.list())).map((d) => d.id)).toEqual([
      savedTable.id,
    ])
  } finally {
    if (second) await closeTracerDatabase(second)
    await closeTracerFixture(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test("ranks individual traces by complete stored USD cost without merging names or counting unknowns as zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-trace-costs-"))
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        [
          {
            id: "expensive",
            attributesJson: JSON.stringify({
              "cost.usd": 2,
              "cost.status": "estimated",
            }),
          },
          { id: "cheap", attributesJson: JSON.stringify({ "cost.usd": 0.01 }) },
          { id: "free", attributesJson: JSON.stringify({ "cost.usd": 0 }) },
          { id: "missing", attributesJson: "{}" },
          {
            id: "partial",
            attributesJson: JSON.stringify({
              "cost.usd": 100,
              "cost.status": "partial",
            }),
          },
          {
            id: "negative",
            attributesJson: JSON.stringify({ "cost.usd": -1 }),
          },
        ].map((row) => ({
          ...row,
          name: "Same name",
          operation: "chat",
          status: "completed",
          startedAt: "2026-09-06T12:00:00Z",
          endedAt: "2026-09-06T12:00:01Z",
        }))
      )
    )
    const result = await executeSemanticQuery(
      {
        ...widget.query,
        measures: ["traces.reportedCostUsd"],
        dimensions: ["traces.trace"],
        filters: [
          {
            member: "traces.hasReportedCost",
            operator: "equals",
            values: ["yes"],
          },
        ],
        order: [["traces.reportedCostUsd", "desc"]],
        limit: 2,
      },
      {
        catalog: semanticCatalog,
        requestId: "rank-cost",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(result.data.map((row) => row["traces.reportedCostUsd"])).toEqual([
      2, 0.01,
    ])
    expect(result.data.map((row) => row["traces.trace"])).toEqual([
      "Same name · expensive",
      "Same name · cheap",
    ])
    expect(result.meta.page.total).toBe(3)
    // SQL filters exclude missing costs before the snapshot facts are loaded.
    expect(result.meta.quality.warnings.length).toBe(1)
    expect(result.meta.quality.warnings.join(" ")).toContain("estimates")
    expect(result.annotation.measures["traces.reportedCostUsd"].currency).toBe(
      "USD"
    )
  } finally {
    await closeTracerFixture(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test("empty dashboards and canvas coordinates survive create, update, reload, and removal of the last widget", async () => {
  const db = await createTracerFixture()
  let reopened: ReturnType<typeof createTracerDatabase> | undefined
  try {
    const service = createDashboardService(db)
    const empty = { ...input, widgets: [] }
    const created = await run(service.create(empty))
    expect(created.widgets).toEqual([])
    const configured = {
      ...input,
      widgets: [{ ...widget, layout: { x: 2, y: 3, w: 6, h: 5 } }],
    }
    const updated = await run(
      service.update(created.id, {
        config: configured,
        expectedRevision: created.revision,
      })
    )
    reopened = reopenTracerFixture(db)
    expect(
      (await run(createDashboardService(reopened).get(created.id))).widgets[0]
        .layout
    ).toEqual({ x: 2, y: 3, w: 6, h: 5 })
    const removed = await run(
      service.update(created.id, {
        config: empty,
        expectedRevision: updated.revision,
      })
    )
    expect(removed.widgets).toEqual([])
    await rejected(
      run(
        service.update(created.id, {
          config: configured,
          expectedRevision: updated.revision,
        })
      ),
      "changed"
    )
  } finally {
    if (reopened) await closeTracerDatabase(reopened)
    await closeTracerFixture(db)
  }
})

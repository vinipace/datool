import { expect, test } from "bun:test"
import { Effect } from "effect"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  executeSemanticQuery,
  validateSemanticQuery,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { healthDashboard } from "@/src/lib/tracer/dashboard-presets"
import { dashboardConfig } from "@/src/lib/tracer/dashboard-autosave"
import {
  dashboardFilterScope,
  scopedWidget,
} from "@/src/lib/tracer/dashboard-queries"
import { createDashboardService } from "@/src/server/tracer/dashboards"
import { spans, traces } from "@/src/server/tracer/schema"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

const now = new Date("2026-09-13T00:00:00Z")
const preset = healthDashboard(now)
const range = preset.widgets[0].query.timeDimensions

test("health preset uses unique descriptive measures, valid queries and a persisted weekly window", () => {
  const measures = semanticCatalog
    .getMembers("spans")
    .filter((m) => m.kind === "measure")
  expect(new Set(measures.map((m) => m.title)).size).toBe(measures.length)
  expect(measures.find((m) => m.name === "spans.erroredCount")?.title).toBe(
    "Failed spans"
  )
  for (const widget of preset.widgets)
    validateSemanticQuery(widget.query, semanticCatalog)
  expect(preset.defaultWindowDays).toBe(7)
  expect(preset.widgets).toHaveLength(10)
  expect(
    preset.widgets.find((widget) => widget.id === "error-types")?.type
  ).toBe("donut")
  const scope = dashboardFilterScope(
    `startedAt >= -${preset.defaultWindowDays}d`,
    now.getTime(),
    "America/Sao_Paulo"
  )
  for (const widget of preset.widgets) {
    expect(
      scopedWidget(widget, scope).query.timeDimensions[0].dateRange
    ).toEqual(range[0].dateRange)
  }
})

test("weekly health reconciles requests, retries, rankings, user identity and empty denominators", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        [
          {
            id: "failed-a",
            name: "Answer",
            status: "errored",
            attributesJson: JSON.stringify({ "user.id": "alice" }),
          },
          {
            id: "failed-b",
            name: "Answer",
            status: "errored",
            attributesJson: JSON.stringify({ "enduser.id": "alice" }),
          },
          {
            id: "failed-unknown",
            name: "Research",
            status: "errored",
            attributesJson: "{}",
          },
          {
            id: "recovered",
            name: "Answer",
            status: "completed",
            attributesJson: JSON.stringify({ userId: "bob" }),
          },
          {
            id: "running",
            name: "Answer",
            status: "running",
            attributesJson: "{}",
          },
          {
            id: "cancelled",
            name: "Answer",
            status: "cancelled",
            attributesJson: "{}",
          },
          // Outside the trace window, but its new span belongs to this week.
          {
            id: "old-parent",
            name: "Old request",
            status: "completed",
            attributesJson: "{}",
            startedAt: "2026-09-05T23:59:59Z",
          },
        ].map((row) => ({
          operation: "chat",
          startedAt: "2026-09-10T12:00:00Z",
          endedAt: "2026-09-10T12:00:01Z",
          ...row,
        }))
      )
    )
    await db.insert(spans).values(
      scopeRows(
        db,
        [
          {
            id: "a-wrapper",
            traceId: "failed-a",
            name: "Answer",
            kind: "agent",
            status: "errored",
            attributesJson: JSON.stringify({
              "error.name": "TimeoutError",
              "error.message": "Provider timed out",
            }),
          },
          {
            id: "a-tool",
            traceId: "failed-a",
            name: "Search",
            kind: "tool",
            status: "errored",
            attributesJson: JSON.stringify({
              "error.type": "TimeoutError",
              "error.message": "Provider timed out",
            }),
          },
          {
            id: "b-tool",
            traceId: "failed-b",
            name: "Search",
            kind: "tool",
            status: "errored",
            attributesJson: JSON.stringify({
              "exception.type": "TimeoutError",
              "exception.message": "Provider timed out",
            }),
          },
          {
            id: "unknown",
            traceId: "failed-unknown",
            name: "Research",
            kind: "agent",
            status: "errored",
            attributesJson: "{}",
          },
          {
            id: "retry",
            traceId: "recovered",
            name: "Search",
            kind: "tool",
            status: "errored",
            attributesJson: JSON.stringify({
              "error.type": "RateLimitError",
              "error.message": "Too many requests",
            }),
          },
          {
            id: "retry-ok",
            traceId: "recovered",
            name: "Search",
            kind: "tool",
            status: "completed",
            attributesJson: "{}",
          },
          {
            id: "old-new",
            traceId: "old-parent",
            name: "Search",
            kind: "tool",
            status: "errored",
            attributesJson: JSON.stringify({
              "error.type": "TimeoutError",
              "error.message": "Provider timed out",
            }),
          },
          {
            id: "running-span",
            traceId: "running",
            name: "Search",
            kind: "tool",
            status: "running",
            attributesJson: "{}",
          },
          {
            id: "cancelled-span",
            traceId: "cancelled",
            name: "Search",
            kind: "tool",
            status: "cancelled",
            attributesJson: "{}",
          },
          // Half-open upper bound must exclude this failure.
          {
            id: "at-end",
            traceId: "failed-a",
            name: "Search",
            kind: "tool",
            status: "errored",
            attributesJson: "{}",
            startedAt: now.toISOString(),
          },
        ].map((row) => ({
          startedAt: "2026-09-10T12:00:00Z",
          endedAt: "2026-09-10T12:00:01Z",
          ...row,
        }))
      )
    )
    const execute = (input: unknown) =>
      executeSemanticQuery(input, {
        catalog: semanticCatalog,
        requestId: "health-test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      })
    const results = new Map<string, Awaited<ReturnType<typeof execute>>>()
    for (const widget of preset.widgets)
      results.set(widget.id, await execute(widget.query))
    expect(results.get("requests")!.data[0]["traces.count"]).toBe(6)
    expect(results.get("failures")!.data[0]["traces.erroredCount"]).toBe(3)
    expect(results.get("failure-rate")!.data[0]["traces.errorRate"]).toBe(0.75)
    expect(results.get("span-errors")!.data[0]["spans.erroredCount"]).toBe(6)
    expect(results.get("failing-traces")!.data[0]).toMatchObject({
      "traces.traceName": "Answer",
      "traces.erroredCount": 2,
      "traces.count": 5,
      "traces.errorRate": 2 / 3,
    })
    expect(results.get("biggest-errors")!.data[0]).toMatchObject({
      "spans.errorMessage": "Provider timed out",
      "spans.erroredCount": 4,
    })
    expect(results.get("error-types")!.data[0]).toMatchObject({
      "spans.errorType": "TimeoutError",
      "spans.erroredCount": 4,
    })
    expect(
      results
        .get("error-types")!
        .data.find((r) => r["spans.errorType"] === null)?.["spans.erroredCount"]
    ).toBe(1)
    expect(results.get("affected-users")!.data[0]).toMatchObject({
      "traces.userId": "alice",
      "traces.erroredCount": 2,
      "traces.errorRate": 1,
    })
    expect(
      results
        .get("affected-users")!
        .data.some((r) => r["traces.userId"] === null)
    ).toBe(true)
    const spanRate = await execute({
      measures: ["spans.erroredCount", "spans.errorRate"],
      timeDimensions: [{ ...range[0], dimension: "spans.startedAt" }],
    })
    expect(
      Math.abs(Number(spanRate.data[0]["spans.errorRate"]) - 6 / 7) < 1e-10
    ).toBe(true)
    const dailySpans = await execute({
      measures: ["spans.erroredCount", "spans.errorRate"],
      timeDimensions: [
        { ...range[0], dimension: "spans.startedAt", granularity: "day" },
      ],
    })
    expect(dailySpans.data).toHaveLength(7)
    expect(dailySpans.data[0]).toMatchObject({
      "spans.erroredCount": 0,
      "spans.errorRate": null,
    })
    // Parent filtering must not convert span status into trace status.
    const filtered = await execute({
      ...spanRate.query,
      filters: [
        {
          member: "spans.parent.status",
          operator: "equals",
          values: ["completed"],
        },
      ],
    })
    expect(filtered.data[0]["spans.erroredCount"]).toBe(2)
    for (const model of ["spans", "traces"]) {
      const empty = await execute({
        measures: [`${model}.erroredCount`, `${model}.errorRate`],
        timeDimensions: [
          {
            dimension: `${model}.startedAt`,
            dateRange: ["2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z"],
          },
        ],
      })
      expect(empty.data[0]).toMatchObject({
        [`${model}.erroredCount`]: 0,
        [`${model}.errorRate`]: null,
      })
      const running = await execute({
        measures: [`${model}.errorRate`],
        timeDimensions: [{ ...range[0], dimension: `${model}.startedAt` }],
        filters: [
          {
            member: model === "spans" ? "spans.spanStatus" : "traces.status",
            operator: "equals",
            values: ["running"],
          },
        ],
      })
      expect(running.data[0][`${model}.errorRate`]).toBeNull()
    }
    let invalidGrouping: unknown
    try {
      await execute({
        measures: ["logs.meanLatencyMs"],
        dimensions: ["logs.errorType"],
        timeDimensions: [{ ...range[0], dimension: "logs.startedAt" }],
      })
    } catch (error) {
      invalidGrouping = error
    }
    expect(
      invalidGrouping instanceof Error &&
        invalidGrouping.message.includes("Span-level")
    ).toBe(true)
    const biggest = preset.widgets.find((w) => w.id === "biggest-errors")!
    const page = await execute({ ...biggest.query, limit: 1, offset: 1 })
    expect(page.meta.page.total).toBe(
      results.get("biggest-errors")!.data.length
    )
    expect(page.data).toEqual(results.get("biggest-errors")!.data.slice(1, 2))
    const service = createDashboardService(db)
    const saved = await Effect.runPromise(service.create(preset))
    expect(dashboardConfig(saved).defaultWindowDays).toBe(7)
    const updated = await Effect.runPromise(
      service.update(saved.id, {
        config: { ...dashboardConfig(saved), name: "Team health" },
        expectedRevision: saved.revision,
      })
    )
    expect(updated.defaultWindowDays).toBe(7)
    expect(updated.widgets).toEqual(preset.widgets)
  } finally {
    await closeTracerFixture(db)
  }
})

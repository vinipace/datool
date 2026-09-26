import { scopeRows } from "./helpers/tracer-fixture"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { traces, spans } from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { createSemanticCatalog } from "@/src/lib/semantic/catalog"
import {
  executeSemanticQuery,
  executeSemanticBatch,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import { validateSemanticQuery } from "@/src/server/semantic/executor"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { calendarBuckets } from "@/src/server/metrics/logs-sql"
import { metricWindow } from "@/src/server/metrics/common"
import { parseSemanticQuery } from "@/src/lib/semantic/query"

const from = "2026-09-07T00:00:00Z",
  to = "2026-09-08T00:00:00Z"
const query = (measures: string[], extra = {}) => ({
  measures: measures.map((m) => `logs.${m}`),
  timeDimensions: [{ dimension: "logs.startedAt", dateRange: [from, to] }],
  ...extra,
})
const trace = (id: string, extra = {}) => ({
  id,
  name: "Same operation",
  operation: "chat",
  status: "completed",
  startedAt: from,
  endedAt: "2026-09-07T00:00:01Z",
  ...extra,
})
const span = (id: string, traceId: string, cost: number, extra = {}) => ({
  id,
  traceId,
  name: id,
  kind: "llm",
  status: "completed",
  startedAt: from,
  attributesJson: JSON.stringify({ "cost.usd": cost }),
  ...extra,
})
async function fixture(
  run: (
    db: ReturnType<typeof createTracerDatabase>,
    execute: (q: unknown) => ReturnType<typeof executeSemanticQuery>
  ) => Promise<void>
) {
  const dir = await mkdtemp(join(tmpdir(), "semantic-consistency-"))
  const db = await createTracerFixture()
  try {
    await run(db, (q) =>
      executeSemanticQuery(q, {
        catalog: semanticCatalog,
        requestId: "test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      })
    )
  } finally {
    await closeTracerFixture(db)
    await rm(dir, { recursive: true, force: true })
  }
}

test("span windows include older parents; ranking and totals reconcile with identical eligibility", () =>
  fixture(async (db, execute) => {
    await db.insert(traces).values(
      scopeRows(db, [
        trace("old", {
          startedAt: "2026-09-06T23:59:00Z",
          attributesJson: '{"cost.usd":999}',
        }),
        trace("new"),
      ])
    )
    await db.insert(spans).values(
      scopeRows(db, [
        span("inside-old", "old", 2),
        span("inside-new", "new", 3),
        span("end-exclusive", "new", 100, { startedAt: to }),
        span("wrapper", "new", 999, { kind: "agent" }),
        span("partial", "new", 500, {
          attributesJson:
            '{"cost.usd":500,"cost.status":"partial","cost.breakdown":{"inputUSD":500}}',
        }),
        span("zero", "new", 0),
        span("missing", "new", 0, { attributesJson: "{}" }),
      ])
    )
    const total = await execute(
      query(["costUsd", "spanCount", "meanLatencyMs", "inputCostUsd"])
    )
    expect(total.data[0]).toMatchObject({
      "logs.costUsd": 5,
      "logs.spanCount": 6,
      "logs.meanLatencyMs": 1000,
      "logs.inputCostUsd": null,
    })
    const ranking = await execute(
      query(["costUsd"], {
        dimensions: ["logs.trace"],
        filters: [
          { member: "logs.hasCost", operator: "equals", values: ["yes"] },
        ],
        order: [["logs.costUsd", "desc"]],
      })
    )
    expect(ranking.data.map((row) => row["logs.trace"])).toEqual([
      "Same operation · new",
      "Same operation · old",
    ])
    expect(
      ranking.data.reduce((sum, row) => sum + Number(row["logs.costUsd"]), 0)
    ).toBe(Number(total.data[0]["logs.costUsd"]))
    const old = await execute(
      query(["costUsd"], {
        filters: traceExpressionFilters("id = old", "logs", Date.parse(to)),
      })
    )
    expect(old.data[0]["logs.costUsd"]).toBe(2)
  }))

test("native JSON filters preserve types, quoted keys, nulls, nesting and parameter safety", () =>
  fixture(async (db, execute) => {
    await db.insert(traces).values(
      scopeRows(db, [
        trace("a", {
          attributesJson: JSON.stringify({
            flag: true,
            nested: { "a.b": { 'a"b': 7 } },
            nil: null,
            metrics: { costUsd: 2 },
            env: "production",
          }),
        }),
        trace("b", { attributesJson: '{"flag":1,"env":"dev"}' }),
      ])
    )
    await db
      .insert(spans)
      .values(scopeRows(db, [span("a-span", "a", 2), span("b-span", "b", 3)]))
    const count = async (filter: string) =>
      (
        await execute(
          query(["spanCount"], {
            filters: traceExpressionFilters(filter, "logs", Date.parse(to)),
          })
        )
      ).data[0]["logs.spanCount"]
    expect(await count("attributes.flag = true")).toBe(1)
    expect(await count("attributes.flag = 1")).toBe(1)
    expect(await count('attributes.nested."a.b".\'a"b\' >= 7')).toBe(1)
    expect(await count("attributes.nil = null")).toBe(1)
    expect(await count("attributes.missing != null")).toBe(0)
    expect(await count("attributes.missing != 5")).toBe(0)
    expect(await count("metrics.costUsd > 1")).toBe(1)
    expect(await count("metadata.env : PROD")).toBe(1)
    expect(await count('name = "x\' OR 1=1 --"')).toBe(0)
    const combined = await execute(
      query(["costUsd"], {
        filters: [
          {
            or: [
              { member: "logs.parent.id", operator: "equals", values: ["a"] },
              {
                and: [
                  {
                    member: "logs.parent.id",
                    operator: "equals",
                    values: ["b"],
                  },
                  {
                    member: "logs.parent.attributes",
                    path: ["env"],
                    operator: "equals",
                    values: ["dev"],
                  },
                ],
              },
            ],
          },
        ],
      })
    )
    expect(combined.data[0]["logs.costUsd"]).toBe(5)
    await assertRejects(
      execute(
        query(["costUsd"], {
          filters: [
            {
              member: "logs.parent.name",
              path: ["x"],
              operator: "equals",
              values: ["a"],
            },
          ],
        })
      ),
      "JSON paths"
    )
    await assertRejects(
      execute(
        query(["costUsd"], {
          filters: [
            {
              member: "logs.parent.attributes",
              path: ["__proto__"],
              operator: "equals",
              values: ["x"],
            },
          ],
        })
      ),
      "Unsafe JSON path"
    )
  }))

test("one real snapshot covers the whole batch despite a writer between queries", () =>
  fixture(async (db) => {
    await db.insert(traces).values(scopeRows(db, trace("a")))
    await db.insert(spans).values(scopeRows(db, span("first", "a", 2)))
    let calls = 0,
      snapshots = 0
    const logs = semanticCatalog.getModel("logs")!
    const catalog = createSemanticCatalog([
      {
        ...logs,
        execute: async (q, ctx) => {
          const result = await logs.execute(q, ctx)
          if (++calls === 1)
            await db.insert(spans).values(scopeRows(db, span("second", "a", 3)))
          return result
        },
      },
    ])
    const runner = createSemanticSnapshotRunner(db)
    const results = await executeSemanticBatch(
      {
        queries: [
          query(["costUsd"]),
          query(["costUsd"], { dimensions: ["logs.trace"] }),
        ],
      },
      {
        catalog,
        requestId: "batch-test",
        snapshotRunner: (callback) => {
          snapshots++
          return runner(callback)
        },
      }
    )
    expect(snapshots).toBe(1)
    expect(results.map((r) => r.data[0]["logs.costUsd"])).toEqual([2, 2])
    expect(results[0].meta.asOf).toBe(results[1].meta.asOf)
    const fresh = await executeSemanticQuery(query(["costUsd"]), {
      catalog,
      requestId: "fresh",
      snapshotRunner: runner,
    })
    expect(fresh.data[0]["logs.costUsd"]).toBe(5)
    await assertRejects(
      executeSemanticBatch(
        { queries: Array(41).fill(query(["costUsd"])) },
        { catalog, requestId: "bad", snapshotRunner: runner }
      ),
      "1–40"
    )
  }))

test("SQL aggregation handles more than 20,000 spans without raw-fact truncation", () =>
  fixture(async (db, execute) => {
    await db.insert(traces).values(scopeRows(db, trace("a")))
    for (let start = 0; start < 20100; start += 100)
      await db.insert(spans).values(
        scopeRows(
          db,
          Array.from({ length: 100 }, (_, i) => span(`s${start + i}`, "a", 1))
        )
      )
    const result = await execute(query(["spanCount", "costUsd"]))
    expect(result.data[0]["logs.spanCount"]).toBe(20100)
    expect(result.data[0]["logs.costUsd"]).toBe(20100)
  }))

test("calendar buckets account for DST and saved ranking queries keep their declared metric population", () => {
  const parsed = parseSemanticQuery(
    query(["spanCount"], {
      timezone: "America/New_York",
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          granularity: "day",
          dateRange: ["2026-03-07T05:00:00Z", "2026-03-10T04:00:00Z"],
        },
      ],
    })
  )
  const buckets = calendarBuckets(metricWindow(parsed, "logs.startedAt"))
  expect(buckets.map((b) => [b.day, (b.to - b.from) / 3600000])).toEqual([
    ["2026-03-07", 24],
    ["2026-03-08", 23],
    ["2026-03-09", 24],
  ])
  const widget = dashboardWidgetSchema.parse({
    id: "ranking",
    title: "Most expensive traces",
    type: "bar",
    width: 1,
    query: {
      measures: ["traces.reportedCostUsd"],
      dimensions: ["traces.trace"],
      timeDimensions: [
        { dimension: "traces.startedAt", dateRange: [from, to] },
      ],
      filters: [
        {
          member: "traces.hasReportedCost",
          operator: "equals",
          values: ["yes"],
        },
      ],
      order: [["traces.reportedCostUsd", "desc"]],
    },
  })
  const validated = validateSemanticQuery(widget.query, semanticCatalog)
  expect(validated.measures).toEqual(["traces.reportedCostUsd"])
  expect(() =>
    validateSemanticQuery(
      {
        ...widget.query,
        filters: [
          {
            member: "traces.filter",
            operator: "equals",
            values: ["status = completed"],
          },
        ],
      },
      semanticCatalog
    )
  ).toThrow()
})

async function assertRejects(promise: Promise<unknown>, message: string) {
  const error = await promise.then(
    () => null,
    (error) => error as Error
  )
  expect(error instanceof Error).toBe(true)
  expect(error?.message ?? "").toContain(message)
}

test("SQL timestamps truncate sub-millisecond fractions and honor offset boundaries", () =>
  fixture(async (db, execute) => {
    await db.insert(traces).values(scopeRows(db, trace("a")))
    await db.insert(spans).values(
      scopeRows(db, [
        span("before", "a", 100, { startedAt: "2026-09-06T23:59:59.9999Z" }),
        span("inside", "a", 1, { startedAt: "2026-09-07T23:59:59.9999Z" }),
        span("offset", "a", 2, { startedAt: "2026-09-06T21:00:00.1-03:00" }),
        span("exclusive", "a", 100, {
          startedAt: "2026-09-07T21:00:00.000-03:00",
        }),
      ])
    )
    const result = await execute(query(["costUsd", "spanCount"]))
    expect(result.data[0]["logs.costUsd"]).toBe(3)
    expect(result.data[0]["logs.spanCount"]).toBe(2)
  }))

test("SQL percentiles retain nearest-rank semantics and daily results are chronological", () =>
  fixture(async (db, execute) => {
    await db.insert(traces).values(
      scopeRows(
        db,
        Array.from({ length: 20 }, (_, i) =>
          trace(`t${i}`, {
            endedAt: new Date(Date.parse(from) + (i + 1) * 1000).toISOString(),
          })
        )
      )
    )
    await db.insert(spans).values(
      scopeRows(
        db,
        Array.from({ length: 20 }, (_, i) =>
          span(`s${i}`, `t${i}`, 1, {
            attributesJson: JSON.stringify({ "ttft.ms": (i + 1) * 10 }),
          })
        )
      )
    )
    const result = await execute(
      query(["p95LatencyMs", "meanLatencyMs", "p95TtftMs", "meanTtftMs"])
    )
    expect(result.data[0]).toMatchObject({
      "logs.p95LatencyMs": 19000,
      "logs.meanLatencyMs": 10500,
      "logs.p95TtftMs": 190,
      "logs.meanTtftMs": 105,
    })
    const days = await execute(
      query(["spanCount"], {
        timeDimensions: [
          {
            dimension: "logs.startedAt",
            granularity: "day",
            dateRange: ["2026-06-10T00:00:00Z", to],
          },
        ],
      })
    )
    expect(days.data.length).toBe(90)
    expect(days.data[0]["logs.startedAt"]).toBe("2026-06-10")
    expect(days.data[89]["logs.startedAt"]).toBe("2026-09-07")
  }))

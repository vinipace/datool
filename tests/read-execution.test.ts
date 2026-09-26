import { test, expect } from "bun:test"
import { sql, eq } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import { traces, spans } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  executeSemanticBatch,
  executeSemanticQuery,
} from "@/src/server/semantic/executor"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { acquireRead } from "@/src/server/semantic/read-budget"
import { readTelemetry } from "@/src/server/semantic/telemetry"

const from = "2026-09-01T00:00:00Z",
  to = "2026-10-01T00:00:00Z"
const trace = (id: string, extra = {}) => ({
  id,
  name: id,
  operation: "test",
  status: "completed",
  startedAt: from,
  endedAt: "2026-09-01T00:00:01Z",
  ...extra,
})

test("native facts update with JSON and child memberships deduplicate, page and disappear on deletion", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(db, [
        trace("a", {
          attributesJson: '{"customer":"acme","cost.usd":2}',
          groupType: "workflow",
          groupName: "Flow",
        }),
        trace("b"),
      ])
    )
    await db.insert(spans).values(
      scopeRows(
        db,
        ["x", "y"].map((id) => ({
          id,
          traceId: "a",
          kind: "agent",
          groupType: "agent",
          groupName: "Agent",
          groupVersion: "v2",
          name: id,
          status: "completed",
          startedAt: from,
        }))
      )
    )
    const service = new TracerService(db)
    const page = await runTracerEffect(
      service.listTraces({
        filter: 'groupType = "agent" groupName = "Agent" groupVersion = "v2"',
        includeTotal: true,
        limit: 1,
      })
    )
    expect(page.total).toBe(1)
    expect(page.items[0].id).toBe("a")
    expect(page.nextCursor).toBeNull()
    await db
      .update(traces)
      .set({
        attributesJson:
          '{"customer":"acme","cost.usd":4,"cost.status":"partial"}',
      })
      .where(eq(traces.id, "a"))
    const facts = await db.execute(
      sql`select pg_typeof(attributes_json)::text as type,cost_usd,reported_cost_usd,duration_ms from traces where id='a'`
    )
    expect(facts.rows[0]).toEqual({
      type: "jsonb",
      cost_usd: null,
      reported_cost_usd: 4,
      duration_ms: 1000,
    })
    const metadata = await runTracerEffect(
      service.listTraces({ filter: 'metadata.customer = "acme"' })
    )
    expect(metadata.items.map((item) => item.id)).toEqual(["a"])
    await db.delete(spans).where(eq(spans.id, "x"))
    expect(
      (
        await runTracerEffect(
          service.listTraces({
            filter: 'groupName = "Agent"',
            includeTotal: true,
          })
        )
      ).total
    ).toBe(1)
    await db.delete(spans).where(eq(spans.id, "y"))
    expect(
      (
        await runTracerEffect(
          service.listTraces({
            filter: 'groupName = "Agent"',
            includeTotal: true,
          })
        )
      ).total
    ).toBe(0)
  } finally {
    await closeTracerFixture(db)
  }
})

test("fused panels preserve individual data, annotations, quality and exact p95 with fewer statements", async () => {
  const db = await createTracerFixture()
  const statements: unknown[] = [],
    observe = (event: unknown) => {
      statements.push(event)
    }
  try {
    await db
      .insert(traces)
      .values(
        scopeRows(db, [
          trace("a", { attributesJson: '{"cost.usd":2}' }),
          trace("b", { endedAt: "2026-09-01T00:00:03Z" }),
          trace("c", { endedAt: null }),
        ])
      )
    const queries = [
      "count",
      "meanDurationMs",
      "p95DurationMs",
      "reportedCostUsd",
    ].map((m) => ({
      measures: [`traces.${m}`],
      timeDimensions: [
        { dimension: "traces.startedAt", dateRange: [from, to] },
      ],
      total: true,
    }))
    const options = {
      catalog: semanticCatalog,
      requestId: "fusion",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    readTelemetry.subscribe(observe)
    const individual = []
    for (const query of queries)
      individual.push(await executeSemanticQuery(query, options))
    const originalStatements = statements.length
    statements.length = 0
    const combined = await executeSemanticBatch({ queries }, options)
    expect(statements.length < originalStatements).toBe(true)
    for (let i = 0; i < queries.length; i++) {
      expect(combined[i].data).toEqual(individual[i].data)
      expect(combined[i].meta.quality).toEqual(individual[i].meta.quality)
      expect(combined[i].annotation).toEqual(individual[i].annotation)
      expect(combined[i].query).toEqual(individual[i].query)
    }
    expect(combined[2].data[0]["traces.p95DurationMs"]).toBe(3000)
  } finally {
    readTelemetry.unsubscribe(observe)
    await closeTracerFixture(db)
  }
})

test("saturating analytics leaves interactive capacity under the shared six-slot ceiling", () => {
  const release = [
    acquireRead("dashboard-a", "analytics"),
    acquireRead("dashboard-b", "analytics"),
  ]
  try {
    expect(() => acquireRead("dashboard-c", "analytics")).toThrow("busy")
    release.push(
      acquireRead("dashboard-a"),
      acquireRead("dashboard-a"),
      acquireRead("browse-b"),
      acquireRead("browse-b")
    )
    expect(() => acquireRead("browse-c")).toThrow("busy")
  } finally {
    release.forEach((done) => done())
  }
})

test("hourly summaries equal raw aggregation after updates, child deletions and trace cascades", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(db, [
        trace("root", {
          groupType: "agent",
          groupName: "A",
          groupVersion: "v1",
        }),
      ])
    )
    await db.insert(spans).values(
      scopeRows(db, [
        {
          id: "child",
          traceId: "root",
          name: "child",
          kind: "agent",
          groupType: "agent",
          groupName: "A",
          groupVersion: "v2",
          status: "completed",
          startedAt: from,
          endedAt: "2026-09-01T00:00:03Z",
        },
      ])
    )
    const options = {
      catalog: semanticCatalog,
      requestId: "summary",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    const query = {
      measures: [
        "agents.count",
        "agents.meanDurationMs",
        "agents.durationSampleCount",
      ],
      dimensions: ["agents.version"],
      timeDimensions: [
        { dimension: "agents.startedAt", dateRange: [from, to] },
      ],
    }
    const verify = async () => {
      const fast = await executeSemanticQuery(query, options)
      const raw = await executeSemanticQuery(
        { ...query, measures: [...query.measures, "agents.p95DurationMs"] },
        options
      )
      expect(fast.data).toEqual(
        raw.data.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => key !== "agents.p95DurationMs"
            )
          )
        )
      )
      expect(fast.meta.quality).toEqual(raw.meta.quality)
      return fast.data
    }
    expect((await verify()).length).toBe(2)
    await db
      .update(traces)
      .set({ endedAt: "2026-09-01T00:00:05Z" })
      .where(eq(traces.id, "root"))
    expect(
      (await verify()).find((row) => row["agents.version"] === "v1")?.[
        "agents.meanDurationMs"
      ]
    ).toBe(5000)
    await db.delete(spans).where(eq(spans.id, "child"))
    expect((await verify()).length).toBe(1)
    await db.delete(traces).where(eq(traces.id, "root"))
    expect((await verify()).length).toBe(0)
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from invocation_hourly_stats`
        )
      ).rows[0].count
    ).toBe(0)
  } finally {
    await closeTracerFixture(db)
  }
})

test("cross-model scalar reuse preserves separate trace and LLM costs and exact latency", async () => {
  const db = await createTracerFixture()
  const statements: unknown[] = [],
    observe = (event: unknown) => {
      statements.push(event)
    }
  try {
    await db
      .insert(traces)
      .values(
        scopeRows(db, [
          trace("a", { attributesJson: '{"cost.usd":2}' }),
          trace("b", { endedAt: "2026-09-01T00:00:03Z" }),
        ])
      )
    await db.insert(spans).values(
      scopeRows(db, [
        {
          id: "s",
          traceId: "b",
          name: "s",
          kind: "llm",
          status: "completed",
          startedAt: from,
          attributesJson: '{"cost.usd":4}',
        },
      ])
    )
    const queries = [
      "traces.count",
      "logs.p95LatencyMs",
      "traces.reportedCostUsd",
      "logs.costUsd",
    ].map((m) => ({
      measures: [m],
      timeDimensions: [
        { dimension: `${m.split(".")[0]}.startedAt`, dateRange: [from, to] },
      ],
    }))
    readTelemetry.subscribe(observe)
    const rows = await executeSemanticBatch(
      { queries },
      {
        catalog: semanticCatalog,
        requestId: "cross-model",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    expect(rows.map((r, i) => r.data[0][queries[i].measures[0]])).toEqual([
      2, 3000, 2, 4,
    ])
    expect(rows[0].meta.quality.status).toBe("complete")
    expect(rows[2].meta.quality.status).toBe("partial")
    expect(statements.length).toBe(3)
  } finally {
    readTelemetry.unsubscribe(observe)
    await closeTracerFixture(db)
  }
})

test("trace keyset pages advance past invalid instants and metadata arrays do not match scalar equality", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(db, [
        trace("a", { attributesJson: '{"customer":"acme"}' }),
        trace("b", {
          startedAt: "invalid",
          attributesJson: '{"customer":["acme"]}',
        }),
        trace("c", { startedAt: "invalid" }),
      ])
    )
    const service = new TracerService(db)
    const one = await runTracerEffect(service.listTraces({ limit: 1 }))
    const two = await runTracerEffect(
      service.listTraces({ limit: 1, cursor: one.nextCursor })
    )
    const three = await runTracerEffect(
      service.listTraces({ limit: 1, cursor: two.nextCursor })
    )
    expect([one.items[0].id, two.items[0].id, three.items[0].id]).toEqual([
      "c",
      "b",
      "a",
    ])
    expect(
      (
        await runTracerEffect(
          service.listTraces({ filter: 'metadata.customer = "acme"' })
        )
      ).items.map((r) => r.id)
    ).toEqual(["a"])
  } finally {
    await closeTracerFixture(db)
  }
})

test("rolling windows combine disjoint raw edges with full-hour summaries", async () => {
  const db = await createTracerFixture()
  try {
    const starts = ["00:00:00", "00:30:00", "01:30:00", "02:30:00", "02:50:00"]
    await db.insert(traces).values(
      scopeRows(
        db,
        starts.map((clock, i) => {
          const startedAt = `2026-09-01T${clock}Z`
          return trace(`edge-${i}`, {
            groupType: "agent",
            groupName: "A",
            startedAt,
            endedAt: new Date(
              Date.parse(startedAt) + (i + 1) * 1000
            ).toISOString(),
          })
        })
      )
    )
    const options = {
      catalog: semanticCatalog,
      requestId: "edges",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    const query = {
      measures: ["agents.count", "agents.meanDurationMs"],
      timeDimensions: [
        {
          dimension: "agents.startedAt",
          dateRange: ["2026-09-01T00:15:00Z", "2026-09-01T02:45:00Z"],
        },
      ],
    }
    const fast = await executeSemanticQuery(query, options)
    const raw = await executeSemanticQuery(
      { ...query, measures: [...query.measures, "agents.p95DurationMs"] },
      options
    )
    expect(fast.data[0]["agents.count"]).toBe(3)
    expect(fast.data[0]["agents.meanDurationMs"]).toBe(3000)
    expect(fast.data).toEqual(
      raw.data.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== "agents.p95DurationMs")
        )
      )
    )
  } finally {
    await closeTracerFixture(db)
  }
})

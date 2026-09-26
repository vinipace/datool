import assert from "node:assert/strict"
import { afterEach, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import type { SpanKind } from "@/src/lib/tracer/contracts"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { spans } from "@/src/server/tracer/schema"
import {
  parseCreateSpan,
  parseCreateTrace,
} from "@/src/server/tracer/validation"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"

const fixtures: Awaited<ReturnType<typeof createTracerFixture>>[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(closeTracerFixture))
})
const group = { type: "workflow", name: "Research", version: "v1" } as const
const startedAt = "2026-09-01T12:15:00.000Z"
const endedAt = "2026-09-01T12:15:01.000Z"
const timing = { startedAt, endedAt, status: "completed" } as const
async function setup() {
  const db = await createTracerFixture()
  fixtures.push(db)
  return { db, service: new TracerService(db) }
}

test("API and storage preserve operation kind independently of optional membership", async () => {
  const { service, db } = await setup()
  const source = parseCreateTrace({
    name: "Parent",
    operation: "task",
    group,
    spans: [{ id: "embedded", name: "Extract", kind: "llm", group }],
  })
  const trace = await run(service.createTrace(source))
  expect(trace.operation).toBe("task")
  expect(trace.spans[0].kind).toBe("llm")
  expect(trace.spans[0].group).toEqual(group)

  for (const kind of [
    "llm",
    "task",
    "tool",
    "function",
    "agent",
    "workflow",
  ] as SpanKind[]) {
    const payload = parseCreateSpan({
      name: `Recorded ${kind}`,
      kind,
      group,
      ...timing,
    })
    const row = await run(service.createSpan(trace.id, payload))
    expect(row.kind).toBe(kind)
    expect(row.group).toEqual(group)
  }
  const standalone = await run(
    service.createSpan(
      trace.id,
      parseCreateSpan({ name: "Standalone", kind: "agent" })
    )
  )
  expect(standalone.kind).toBe("agent")
  expect(standalone.group).toBeNull()
  const page = await run(
    service.listTraceSpans(trace.id, { includeTotal: true })
  )
  expect(page.items.find((span) => span.id === "embedded")?.group).toEqual(
    group
  )

  const changed = await run(service.patchSpan("embedded", { kind: "function" }))
  expect(changed.kind).toBe("function")
  expect(changed.group).toEqual(group)
  await assert.rejects(
    () =>
      db
        .update(spans)
        .set({ groupType: "agent" })
        .where(eq(spans.id, "embedded")),
    /Group membership cannot change|Failed query/
  )
  const afterRejectedChange = await run(service.listTraceSpans(trace.id))
  expect(
    afterRejectedChange.items.find((span) => span.id === "embedded")?.group
  ).toEqual(group)
})

test("one workflow finds multiple step traces and separately grouped spans without duplicate trace rows", async () => {
  const { service } = await setup()
  const ids: string[] = []
  for (const operation of ["llm", "task", "tool"]) {
    const trace = await run(
      service.createTrace({ name: operation, operation, group, ...timing })
    )
    ids.push(trace.id)
  }
  const parent = await run(
    service.createTrace({
      name: "Other trace",
      operation: "function",
      ...timing,
    })
  )
  for (let i = 0; i < 2; i++) {
    await run(
      service.createSpan(parent.id, {
        name: `Step ${i}`,
        kind: "llm",
        group,
        ...timing,
      })
    )
  }
  const page = await run(
    service.listTraces({
      filter: "groupType = workflow groupName = Research groupVersion = v1",
      includeTotal: true,
    })
  )
  expect(page.total).toBe(4)
  expect(new Set(page.items.map((trace) => trace.id))).toEqual(
    new Set([...ids, parent.id])
  )
  expect(
    page.items
      .filter((trace) => trace.group)
      .map((trace) => trace.operation)
      .sort()
  ).toEqual(["llm", "task", "tool"])
  const differentVersion = await run(
    service.listTraces({
      filter: "groupType = workflow groupName = Research groupVersion = v2",
      includeTotal: true,
    })
  )
  expect(differentVersion.total).toBe(0)
})

test("summary and raw group metrics include every operation kind and retain LLM cost coverage", async () => {
  const { service, db } = await setup()
  const trace = await run(service.createTrace({ name: "Steps", ...timing }))
  for (const kind of ["llm", "task", "tool"] as const) {
    await run(
      service.createSpan(trace.id, { name: kind, kind, group, ...timing })
    )
  }
  await run(
    service.createSpan(trace.id, {
      name: "Ungrouped agent",
      kind: "agent",
      ...timing,
    })
  )
  const common = {
    dimensions: ["workflows.name"],
    timeDimensions: [
      {
        dimension: "workflows.startedAt",
        dateRange: ["2026-09-01T12:00:00Z", "2026-09-01T14:00:00Z"] as [
          string,
          string,
        ],
      },
    ],
  }
  const summary = await run(
    service.querySemanticMetrics({
      ...common,
      measures: ["workflows.count", "workflows.meanDurationMs"],
    })
  )
  const raw = await run(
    service.querySemanticMetrics({
      ...common,
      measures: [
        "workflows.count",
        "workflows.p95DurationMs",
        "workflows.completeCostCount",
      ],
    })
  )
  expect(summary.data[0]["workflows.count"]).toBe(3)
  expect(summary.data[0]["workflows.meanDurationMs"]).toBe(1000)
  expect(raw.data[0]["workflows.count"]).toBe(3)
  expect(raw.data[0]["workflows.p95DurationMs"]).toBe(1000)
  expect(raw.data[0]["workflows.completeCostCount"]).toBe(0)
  const stats = await db.execute(
    sql`select kind, sum(row_count)::integer as count from invocation_hourly_stats group by kind`
  )
  expect(stats.rows).toEqual([{ kind: "workflow", count: 3 }])
})

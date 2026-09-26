import { afterAll, beforeAll, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { quoteFilterText } from "@/components/ui/datool/search-bar/filter-draft"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { getTracerProjectId, type TracerDatabase } from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { spans, traces } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

const startedAt = "2026-09-07T00:00:00Z"
const from = "2026-09-06T00:00:00Z"
const to = "2026-09-08T00:00:00Z"
const phrase = "Needle in the haystack"
const deepText = 'Deep payload: "invoice" C:\\billing 100%_paid São Paulo'
const depth = 128
let database: TracerDatabase
let service: TracerService

beforeAll(async () => {
  database = await createTracerFixture()
  service = new TracerService(database)
  await database.insert(traces).values(
    scopeRows(
      database,
      Array.from({ length: 65 }, (_, index) => ({
        id: `trace-${String(index).padStart(2, "0")}`,
        name: index === 0 ? phrase : "Ordinary trace",
        operation: "test",
        status: "completed",
        startedAt,
        endedAt: "2026-09-07T00:00:01Z",
      }))
    )
  )
  await database.insert(spans).values(
    scopeRows(
      database,
      Array.from({ length: depth + 1 }, (_, index) => ({
        id: `deep-span-${index}`,
        traceId: "trace-01",
        parentId: index ? `deep-span-${index - 1}` : null,
        name: index === depth ? "Deep lookup" : "Ordinary span",
        kind: index === depth ? "tool" : "internal",
        status: index === depth ? "errored" : "completed",
        // Full-text matching is trace-wide, even if this span is outside a chart window.
        startedAt: index === depth ? "2026-09-09T00:00:00Z" : startedAt,
        endedAt:
          index === depth ? "2026-09-09T00:00:01Z" : "2026-09-07T00:00:01Z",
        ...(index === depth
          ? {
              groupType: "agent",
              groupName: "Nested billing team",
              groupVersion: "release-canary",
              inputJson: JSON.stringify({
                messages: [{ content: "Find the receipt" }],
              }),
              outputJson: JSON.stringify({
                result: { chunks: [phrase, deepText] },
              }),
              attributesJson: JSON.stringify({
                source: { region: "Curitiba" },
                error: { message: "Payment declined" },
                unsearchable_key: 987654321,
                flag: true,
              }),
            }
          : {}),
      }))
    )
  )
  await database.insert(spans).values(
    scopeRows(database, [
      {
        id: "first-match",
        traceId: "trace-02",
        name: phrase,
        kind: "internal",
        status: "completed",
        startedAt,
        inputJson: "invalid json",
      },
      {
        id: "second-match",
        traceId: "trace-02",
        parentId: "first-match",
        name: "Sibling",
        kind: "internal",
        status: "completed",
        startedAt,
        attributesJson: JSON.stringify({
          text: phrase,
          topic: "Unique sibling text",
        }),
      },
    ])
  )
  await database.insert(spans).values(
    scopeRows(database, [
      {
        id: "function-parent",
        traceId: "trace-03",
        name: "unrelated-parent",
        kind: "internal",
        status: "completed",
        startedAt,
        attributesJson: JSON.stringify({
          "ai.telemetry.functionId": "extract-brands",
        }),
      },
      {
        id: "function-child",
        traceId: "trace-03",
        parentId: "function-parent",
        name: "extract-brands:ai.generateText",
        kind: "llm",
        status: "completed",
        startedAt,
      },
      {
        id: "other-function",
        traceId: "trace-04",
        name: "extract-brands-extended:ai.generateText",
        kind: "llm",
        status: "completed",
        startedAt,
        attributesJson: JSON.stringify({
          "ai.telemetry.functionId": "extract-brands-extended",
        }),
      },
      {
        id: "legacy-function",
        traceId: "trace-05",
        name: "extract-brands:ai.generateText.doGenerate",
        kind: "llm",
        status: "completed",
        startedAt,
        attributesJson: JSON.stringify({ "ai.functionId": "extract-brands" }),
      },
      {
        id: "named-function",
        traceId: "trace-06",
        name: "named-function",
        kind: "function",
        status: "completed",
        startedAt,
      },
      {
        id: "named-function-child",
        traceId: "trace-06",
        parentId: "named-function",
        name: "ai.generateText",
        kind: "llm",
        status: "completed",
        startedAt,
      },
    ])
  )
  // Another tenant's matching trace must not enter the list or semantic results.
  await database.execute(sql`insert into project
    (id, organization_id, name, slug, created_at, updated_at)
    select 'foreign-project', organization_id, 'Foreign', 'foreign', created_at, updated_at
    from project where id = ${getTracerProjectId(database)}`)
  await database.insert(traces).values({
    id: "foreign-trace",
    projectId: "foreign-project",
    name: "Foreign",
    operation: "test",
    status: "completed",
    startedAt,
  })
  await database.insert(spans).values({
    id: "foreign-span",
    projectId: "foreign-project",
    traceId: "foreign-trace",
    name: phrase,
    kind: "tool",
    status: "completed",
    startedAt,
    outputJson: JSON.stringify("Foreign-only secret"),
  })
})

afterAll(async () => {
  if (database) await closeTracerFixture(database)
})

const list = (filter: string, cursor?: string) =>
  runTracerEffect(
    service.listTraces({
      filter,
      cursor,
      limit: 2,
      includeTotal: true,
    })
  )

const execute = (
  model: "traces" | "logs",
  filter: string,
  dimensions: string[] = []
) =>
  executeSemanticQuery(
    {
      measures:
        model === "traces"
          ? ["traces.count"]
          : ["logs.spanCount", "logs.meanLatencyMs"],
      dimensions,
      timeDimensions: [
        { dimension: `${model}.startedAt`, dateRange: [from, to] },
      ],
      filters: traceExpressionFilters(filter, model, Date.parse(to)),
      total: true,
    },
    {
      catalog: semanticCatalog,
      requestId: "trace-span-search-test",
      snapshotRunner: createSemanticSnapshotRunner(database),
    }
  )

test("matches the trace or any descendant before pagination and totals, without duplicates", async () => {
  const filter = quoteFilterText(phrase.toUpperCase())
  // All three matches are beyond the first unfiltered page of 50.
  const first = await list(filter)
  expect(first.total).toBe(3)
  expect(first.items.map((row) => row.id)).toEqual(["trace-02", "trace-01"])
  expect(first.nextCursor).toBe("trace-01")
  const second = await list(filter, first.nextCursor!)
  expect(second.total).toBe(3)
  expect(second.items.map((row) => row.id)).toEqual(["trace-00"])
  expect(second.nextCursor).toBeNull()
  expect((await list('"Foreign-only secret"')).total).toBe(0)
})

test("searches deep span text and decoded JSON strings literally", async () => {
  for (const text of [
    "deep-span-128",
    "DEEP LOOKUP",
    "tool",
    "errored",
    "agent",
    "nested billing",
    "release-canary",
    "find the receipt",
    "curitiba",
    "payment declined",
    deepText,
    '"invoice"',
    "C:\\billing",
    "%_paid",
    "São Paulo",
  ]) {
    const result = await list(quoteFilterText(text))
    expect(result.total).toBe(1)
    expect(result.items[0].id).toBe("trace-01")
  }
  for (const text of [
    "absent",
    "unsearchable_key",
    "987654321",
    "true",
    "invalid json",
    "x' OR true --",
  ]) {
    expect((await list(quoteFilterText(text))).total).toBe(0)
  }
})

test("combines full-text matches across spans while preserving structured trace filters", async () => {
  expect(
    (await list(`${quoteFilterText(phrase)} "Unique sibling text"`)).items.map(
      (row) => row.id
    )
  ).toEqual(["trace-02"])
  expect((await list('"Deep payload" status = completed')).total).toBe(1)
  expect((await list('"Deep payload" status = errored')).total).toBe(0)
  expect((await list('name contains "Deep lookup"')).total).toBe(0)
  expect((await list('output contains "Deep payload"')).total).toBe(0)
  expect((await list('"Deep payload" startedAt >= "2026-09-08"')).total).toBe(0)
})

test("semantic trace counts and log aggregates share the trace-wide match", async () => {
  const filter = quoteFilterText(phrase)
  expect((await execute("traces", filter)).data[0]["traces.count"]).toBe(3)
  const grouped = await execute("traces", filter, ["traces.status"])
  expect(grouped.data).toHaveLength(1)
  expect(grouped.data[0]).toMatchObject({
    "traces.status": "completed",
    "traces.count": 3,
  })
  expect((await execute("logs", filter)).data[0]).toMatchObject({
    "logs.spanCount": depth + 2,
    "logs.meanLatencyMs": 1000,
  })
  // The sole match is outside the log window; its trace's nonmatching spans still count.
  expect((await execute("logs", '"Deep payload"')).data[0]).toMatchObject({
    "logs.spanCount": depth,
    "logs.meanLatencyMs": 1000,
  })
  expect(
    (await execute("traces", '"Foreign-only secret"')).data[0]["traces.count"]
  ).toBe(0)
})

test("traceOrSpanName searches only names at any depth, once per trace", async () => {
  const filter = `traceOrSpanName = ${quoteFilterText(phrase)}`
  const result = await list(filter)
  expect(result.total).toBe(2)
  expect(result.items.map((row) => row.id)).toEqual(["trace-02", "trace-00"])
  expect(
    (await list('traceOrSpanName contains "DEEP LOOKUP"')).items.map(
      (row) => row.id
    )
  ).toEqual(["trace-01"])
  expect(
    (await list('traceOrSpanName contains "Payment declined"')).total
  ).toBe(0)
  expect(
    (await list(`traceOrSpanName != ${quoteFilterText(phrase)}`)).total
  ).toBe(63)
  expect(
    (
      await list(
        'traceOrSpanName contains "Deep lookup" startedAt >= "2026-09-08"'
      )
    ).total
  ).toBe(0)
  expect((await execute("traces", filter)).data[0]["traces.count"]).toBe(2)
})

test("functionName equality shares chart attribution and does not match prefixes", async () => {
  const filter = 'functionName = "extract-brands"'
  const result = await list(filter)
  expect(result.total).toBe(2)
  expect(result.items.map((row) => row.id)).toEqual(["trace-05", "trace-03"])
  expect((await list('traceOrSpanName = "extract-brands"')).total).toBe(0)
  expect(
    (await list('functionName = "named-function"')).items.map((row) => row.id)
  ).toEqual(["trace-06"])
  expect((await list('functionName != "extract-brands"')).total).toBe(63)
  expect((await execute("traces", filter)).data[0]["traces.count"]).toBe(2)
  expect((await execute("logs", filter)).data[0]["logs.spanCount"]).toBe(3)
})

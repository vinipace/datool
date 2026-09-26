import { afterEach, describe, expect, test } from "bun:test"
import { Pool } from "pg"

import {
  createTracerDatabase,
  closeTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { spans, traces } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import type { SemanticQueryInput } from "@/src/lib/semantic"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: { database: TracerDatabase; target: IsolatedPostgres }[] = []
let currentProjectId = ""
afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})
async function setup() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  currentProjectId = target.projectId
  resources.push({ database, target })
  return {
    database,
    projectId: target.projectId,
    service: new TracerService(database),
    target,
  }
}

async function insertOtherProjectInvocation(target: IsolatedPostgres) {
  const projectId = crypto.randomUUID()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    await pool.query(
      "INSERT INTO project (id, organization_id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
      [
        projectId,
        target.organizationId,
        "Other project",
        `other-${projectId.slice(0, 12)}`,
        start,
      ]
    )
    await pool.query(
      "INSERT INTO traces (id, project_id, name, operation, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        "foreign-trace",
        projectId,
        "Foreign",
        "other",
        "{}",
        "completed",
        start,
        end,
      ]
    )
    await pool.query(
      "INSERT INTO spans (id, project_id, trace_id, name, kind, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        "foreign-span",
        projectId,
        "foreign-trace",
        "Foreign Agent",
        "agent",
        "{}",
        "completed",
        start,
        end,
      ]
    )
  } finally {
    await pool.end()
  }
}
const start = "2026-09-01T12:00:00.000Z"
const end = "2026-09-01T12:00:01.000Z"
const measures = [
  "count",
  "erroredCount",
  "errorRate",
  "runningCount",
  "cancelledCount",
  "meanDurationMs",
  "p95DurationMs",
  "durationSampleCount",
  "reportedCostUsd",
  "costSampleCount",
  "completeCostCount",
]
function query(
  service: TracerService,
  model: "agents" | "workflows",
  override: Partial<SemanticQueryInput> = {}
) {
  return runTracerEffect(
    service.querySemanticMetrics({
      measures: measures.map((name) => `${model}.${name}`),
      dimensions: [`${model}.name`],
      timeDimensions: [
        {
          dimension: `${model}.startedAt`,
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
        },
      ],
      total: true,
      ...override,
    })
  )
}
function span(
  id: string,
  options: Partial<typeof spans.$inferInsert> = {}
): typeof spans.$inferInsert {
  return {
    id,
    projectId: currentProjectId,
    traceId: "trace",
    kind: "agent",
    name: "Reviewer",
    startedAt: start,
    endedAt: end,
    status: "completed",
    ...options,
    groupType: options.groupType ?? (["agent", "workflow"].includes(options.kind ?? "agent") ? options.kind ?? "agent" : null),
    groupName: ["agent", "workflow"].includes(options.kind ?? "agent")
      ? (options.groupName ?? options.name ?? "Reviewer")
      : null,
  }
}

describe("named agent and workflow performance", () => {
  test("aggregates versions before pagination with exact distinct counts in raw and hourly queries", async () => {
    const { database, projectId, service } = await setup()
    await database.insert(traces).values({
      id: "trace", projectId, name: "Parent", operation: "test",
      status: "completed", startedAt: start, endedAt: end,
    })
    const samples = [
      { version: "v1", at: "12:45", duration: 1000, status: "completed" },
      { version: "v1", at: "13:15", duration: 1000, status: "completed" },
      { version: "v2", at: "14:15", duration: 9000, status: "errored" },
      { version: null, at: "15:15", duration: 3000, status: "completed" },
    ] as const
    for (const kind of ["agent", "workflow"] as const) {
      await database.insert(spans).values([
        ...samples.map((sample, index) => {
          const startedAt = `2026-09-01T${sample.at}:00.000Z`
          return span(`${kind}-${index}`, {
            kind, groupName: "Worker", groupVersion: sample.version,
            status: sample.status, startedAt,
            endedAt: new Date(Date.parse(startedAt) + sample.duration).toISOString(),
          })
        }),
        span(`${kind}-unversioned`, { kind, groupName: "Other", startedAt: "2026-09-01T13:00:00.000Z", endedAt: "2026-09-01T13:00:01.000Z" }),
        span(`${kind}-outside`, { kind, groupName: "Worker", groupVersion: "v3", startedAt: "2026-09-01T11:00:00.000Z", endedAt: "2026-09-01T11:00:01.000Z" }),
      ])
      const model = kind === "agent" ? "agents" : "workflows"
      const base: Partial<SemanticQueryInput> = {
        measures: ["count", "versionCount", "meanDurationMs", "errorRate"].map(key => `${model}.${key}`),
        timeDimensions: [{ dimension: `${model}.startedAt`, dateRange: ["2026-09-01T12:30:00.000Z", "2026-09-01T15:30:00.000Z"] }],
        order: [[`${model}.count`, "desc"]], limit: 1,
      }
      const summarized = await query(service, model, base)
      // P95 requires raw observations, while the base query uses hourly summaries
      // plus both partial edge hours. Distinct versions must agree across paths.
      const raw = await query(service, model, { ...base, measures: [...base.measures!, `${model}.p95DurationMs`] })
      for (const result of [summarized, raw]) {
        expect(result.meta.page.total).toBe(2)
        expect(result.data).toHaveLength(1)
        expect(result.data[0]).toMatchObject({
          [`${model}.name`]: "Worker",
          [`${model}.count`]: 4,
          [`${model}.versionCount`]: 2,
          [`${model}.meanDurationMs`]: 3500,
          [`${model}.errorRate`]: 0.25,
        })
        expect(`${model}.version` in result.data[0]).toBe(false)
      }
      expect(raw.data[0][`${model}.p95DurationMs`]).toBe(9000)
      const next = await query(service, model, { ...base, offset: 1 })
      expect(next.data[0]).toMatchObject({ [`${model}.name`]: "Other", [`${model}.versionCount`]: 0 })
      const filtered = await query(service, model, { ...base, filters: [{ member: `${model}.version`, operator: "equals", values: ["v1"] }] })
      expect(filtered.data[0]).toMatchObject({ [`${model}.count`]: 2, [`${model}.versionCount`]: 1 })
    }
  })

  test("quoted search matches names and versions without changing exact identity comparisons", async () => {
    const { database, projectId, service } = await setup()
    await database.insert(traces).values([
      { id: "trace", projectId, name: "Parent", operation: "test", status: "completed", startedAt: start, endedAt: end, groupType: "workflow", groupName: "Invoice Flow", groupVersion: "Release-2" },
      { id: "other", projectId, name: "Other", operation: "test", status: "completed", startedAt: start, endedAt: end, groupType: "workflow", groupName: "Other Flow" },
    ])
    await database.insert(spans).values([
      span("billing", { groupName: "Invoice Agent", groupVersion: "Release-2" }),
      span("other-agent", { groupName: "Other Agent" }),
    ])
    for (const model of ["agents", "workflows"] as const) {
      for (const text of ["INVOICE", "release-2"]) {
        const result = await query(service, model, {
          filters: [{ member: `${model}.fullText`, operator: "contains", values: [text] }],
          limit: 1,
        })
        expect(result.meta.page.total).toBe(1)
        expect(result.data[0][`${model}.name`]).toBe(model === "agents" ? "Invoice Agent" : "Invoice Flow")
      }
      const exact = await query(service, model, {
        filters: [{ member: `${model}.name`, operator: "equals", values: [model === "agents" ? "invoice agent" : "invoice flow"] }],
      })
      expect(exact.meta.page.total).toBe(0)
    }
  })

  test("groups named invocations, excludes running/cancelled from errors and latency, and retains missing versus zero cost", async () => {
    const { database, projectId, service, target } = await setup()
    await database.insert(traces).values({
      id: "trace",
      projectId,
      name: "Request 123",
      operation: "onboarding",
      status: "completed",
      startedAt: start,
      endedAt: end,
      groupType: "workflow",
      groupName: "Onboarding",
    })
    await database.insert(spans).values([
      span("a", { attributesJson: JSON.stringify({ "cost.usd": 0.1 }) }),
      span("b", {
        status: "errored",
        endedAt: "2026-09-01T12:00:03Z",
        attributesJson: JSON.stringify({ "cost.usd": 0.2 }),
      }),
      span("c", { status: "running", endedAt: null }),
      span("d", { status: "cancelled", endedAt: "2026-09-01T12:00:09Z" }),
      span("free", {
        name: "Cached",
        attributesJson: JSON.stringify({ "cost.usd": 0 }),
      }),
      span("unknown", {
        name: "Unknown",
        attributesJson: JSON.stringify({ "cost.usd": -5 }),
      }),
      span("alias", {
        name: "Request 456",
        groupName: "Reviewer",
        attributesJson: JSON.stringify({
          "agent.name": "Reviewer",
          "cost.usd": 0,
        }),
      }),
    ])
    await insertOtherProjectInvocation(target)
    const result = await query(service, "agents")
    const reviewer = result.data.find(
      (row) => row["agents.name"] === "Reviewer"
    )!
    expect(reviewer).toMatchObject({
      "agents.count": 5,
      "agents.erroredCount": 1,
      "agents.errorRate": 1 / 3,
      "agents.runningCount": 1,
      "agents.cancelledCount": 1,
      "agents.p95DurationMs": 3000,
      "agents.durationSampleCount": 3,
      "agents.costSampleCount": 3,
      "agents.completeCostCount": 3,
    })
    expect(
      Math.abs(Number(reviewer["agents.meanDurationMs"]) - 5000 / 3)
    ).toBeLessThan(1e-10)
    expect(
      Math.abs(Number(reviewer["agents.reportedCostUsd"]) - 0.3)
    ).toBeLessThan(1e-10)
    expect(
      result.data.find((row) => row["agents.name"] === "Cached")?.[
        "agents.reportedCostUsd"
      ]
    ).toBe(0)
    expect(
      result.data.find((row) => row["agents.name"] === "Unknown")?.[
        "agents.reportedCostUsd"
      ]
    ).toBeNull()
    expect(result.meta.quality.status).toBe("partial")
    expect(
      result.data.some((row) => row["agents.name"] === "Foreign Agent")
    ).toBe(false)
    const workflows = await query(service, "workflows")
    expect(workflows.data).toHaveLength(1)
    expect(workflows.data[0]).toMatchObject({
      "workflows.name": "Onboarding",
      "workflows.count": 1,
    })
  })

  test("rolls up descendant cost once, honors inclusive totals, and reports incomplete LLM coverage", async () => {
    const { database, projectId, service } = await setup()
    await database.insert(traces).values({
      id: "trace",
      projectId,
      name: "Onboarding",
      operation: "run",
      status: "completed",
      startedAt: start,
      endedAt: end,
      groupType: "workflow",
      groupName: "Onboarding",
    })
    await database.insert(spans).values([
      span("agent", { name: "Planner" }),
      span("llm", {
        parentId: "agent",
        kind: "llm",
        attributesJson: '{"cost.usd":0.25}',
      }),
      span("nested", {
        parentId: "llm",
        kind: "tool",
        attributesJson: '{"cost.usd":99}',
      }),
      span("unreported", { parentId: "agent", kind: "llm" }),
      span("sibling", { kind: "tool", attributesJson: '{"cost.usd":0.5}' }),
    ])
    const agents = await query(service, "agents")
    expect(agents.data[0]).toMatchObject({
      "agents.reportedCostUsd": 0.25,
      "agents.costSampleCount": 1,
      "agents.completeCostCount": 0,
    })
    const workflows = await query(service, "workflows")
    expect(workflows.data[0]).toMatchObject({
      "workflows.reportedCostUsd": 0.75,
      "workflows.completeCostCount": 0,
    })
    await database
      .update(traces)
      .set({ attributesJson: '{"kind":"workflow","cost.usd":1}' })
    const overridden = await query(service, "workflows")
    expect(overridden.data[0]).toMatchObject({
      "workflows.reportedCostUsd": 1,
      "workflows.completeCostCount": 1,
    })
  })

  test("does not classify untyped traces as workflows; supports explicit roots, workflow spans, name filters, pagination, and invocation links", async () => {
    const { database, projectId, service } = await setup()
    await database.insert(traces).values([
      {
        id: "trace",
        projectId,
        name: "Chat",
        operation: "chat",
        startedAt: start,
        status: "completed",
      },
      {
        id: "root-agent",
        projectId,
        name: "Helper",
        operation: "assist",
        startedAt: start,
        endedAt: end,
        status: "completed",
        groupType: "agent",
        groupName: "Assistant",
      },
    ])
    await database
      .insert(spans)
      .values([
        span("wf", { kind: "workflow", name: "Nested workflow" }),
        span("agent-a", { name: "A" }),
        span("agent-b", { name: "B" }),
      ])
    const workflows = await query(service, "workflows")
    expect(workflows.data.map((row) => row["workflows.name"])).toEqual([
      "Nested workflow",
    ])
    const page = await query(service, "agents", {
      limit: 1,
      offset: 1,
      order: [["agents.name", "asc"]],
    })
    expect(page.meta.page.total).toBe(3)
    expect(page.data[0]?.["agents.name"]).toBe("Assistant")
    const detail = await query(service, "agents", {
      dimensions: [
        "agents.name",
        "agents.invocationId",
        "agents.traceId",
        "agents.source",
        "agents.status",
      ],
      filters: [{ member: "agents.name", operator: "equals", values: ["A"] }],
    })
    expect(detail.data[0]).toMatchObject({
      "agents.invocationId": "agent-a",
      "agents.traceId": "trace",
      "agents.source": "span",
      "agents.status": "completed",
    })
  })

  test("handles offset timestamps, invalid durations, zero latency, all-running rates, and exclusive upper time bounds", async () => {
    const { database, projectId, service } = await setup()
    await database.insert(traces).values({
      id: "trace",
      projectId,
      name: "test",
      operation: "test",
      status: "running",
      startedAt: start,
    })
    await database.insert(spans).values([
      span("offset", {
        name: "Offsets",
        startedAt: "2026-08-31T22:00:00-03:00",
        endedAt: "2026-08-31T22:00:00-03:00",
      }),
      span("invalid", { name: "Offsets", endedAt: "2026-09-01T11:00:00Z" }),
      span("upper", { name: "Excluded", startedAt: "2026-09-02T00:00:00Z" }),
      span("running", { name: "Running", status: "running", endedAt: null }),
    ])
    const result = await query(service, "agents")
    expect(result.data).toHaveLength(2)
    expect(
      result.data.find((row) => row["agents.name"] === "Offsets")
    ).toMatchObject({
      "agents.count": 2,
      "agents.meanDurationMs": 0,
      "agents.durationSampleCount": 1,
    })
    expect(
      result.data.find((row) => row["agents.name"] === "Running")
    ).toMatchObject({ "agents.errorRate": null, "agents.meanDurationMs": null })
    expect(
      result.meta.quality.warnings.some((warning) =>
        warning.includes("latency")
      )
    ).toBe(true)
  })
})

test("explicit version groups scale beyond the old raw cap; metadata stays ungrouped", async () => {
  const { database, projectId, service } = await setup()
  await database.insert(traces).values({
    id: "trace",
    projectId,
    name: "Container",
    operation: "test",
    startedAt: start,
    status: "completed",
    attributesJson: '{"agent.name":"Wrong"}',
  })
  for (let offset = 0; offset < 21_000; offset += 500)
    await database.insert(spans).values(
      Array.from({ length: 500 }, (_, i) =>
        span(`large-${offset + i}`, {
          groupType: "agent",
          groupName: "Worker",
          groupVersion: (offset + i) % 2 ? "v2" : null,
        })
      )
    )
  await database.insert(spans).values({
    id: "legacy",
    projectId,
    traceId: "trace",
    name: "Worker",
    kind: "agent",
    startedAt: start,
    status: "completed",
    attributesJson: '{"agent.name":"Worker"}',
  })
  const result = await query(service, "agents", {
    measures: ["agents.count"],
    dimensions: ["agents.name", "agents.version"],
    order: [["agents.version", "asc"]],
    limit: 1,
  })
  expect(result.data).toEqual([
    {
      "agents.name": "Worker",
      "agents.version": null,
      "agents.startedAt": null,
      "agents.count": 10_500,
    },
  ])
  expect(result.meta.page.total).toBe(2)
  const deep = await query(service, "agents", {
    measures: ["agents.count"],
    dimensions: ["agents.name", "agents.version"],
    offset: 10,
    limit: 1,
  })
  expect(deep.data).toEqual([])
  expect(deep.meta.page.total).toBe(2)
  const filtered = await runTracerEffect(
    service.listTraces({
      filter: "groupType = agent groupName = Worker groupVersion = v2",
    })
  )
  expect(filtered.items.map((t) => t.id)).toEqual(["trace"])
})

test("group validation and immutable identity apply to direct service writes", async () => {
  const { service, database } = await setup()
  const trace = await runTracerEffect(
    service.createTrace({
      name: "Grouped",
      group: { type: "workflow", name: "  Flow ", version: " v1 " },
    })
  )
  expect(trace.group).toEqual({ type: "workflow", name: "Flow", version: "v1" })
  const ungrouped = await runTracerEffect(
    service.createSpan(trace.id, { name: "Standalone agent", kind: "agent" })
  )
  expect(ungrouped.group).toBeNull()
  const groupedTool = await runTracerEffect(
    service.createSpan(trace.id, {
      name: "Tool in agent", kind: "tool", group: { type: "agent", name: "A" },
    })
  )
  expect(groupedTool.kind).toBe("tool")
  expect(groupedTool.group?.type).toBe("agent")
  const created = await runTracerEffect(
    service.createSpan(trace.id, {
      name: "Good",
      group: { type: "agent", name: "A" },
    })
  )
  expect(created.kind).toBe("custom")
  expect(created.group?.version).toBeNull()
  const mutation = await database
    .update(traces)
    .set({ groupName: "Changed" })
    .then(
      () => null,
      (error) => error
    )
  expect(mutation).toBeInstanceOf(Error)
})

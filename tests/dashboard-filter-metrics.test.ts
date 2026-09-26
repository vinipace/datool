import { expect, test } from "bun:test"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { spans, traces } from "@/src/server/tracer/schema"
import { dashboardGroupFilters } from "@/src/lib/tracer/dashboard-filters"
import type { InvocationSelection } from "@/src/lib/semantic/group-filter"

test("dashboard filters use exact persisted memberships without multiplying metrics or leaking projects", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const service = new TracerService(db)
  const startedAt = "2026-09-01T12:00:00Z"
  const insert = async (
    id: string,
    name: string,
    version: string | null,
    cost: number,
    duplicates = 1,
    projectId = target.projectId
  ) => {
    await db.insert(traces).values({
      id,
      projectId,
      name: "Briefing",
      operation: "test",
      status: "completed",
      startedAt,
      endedAt: `2026-09-01T12:00:0${cost}Z`,
      groupType: "workflow",
      groupName: "Briefing",
      attributesJson: JSON.stringify({
        environment: cost >= 2 ? "production" : "staging",
        metrics: { quality: cost },
      }),
    })
    await db.insert(spans).values(
      Array.from({ length: duplicates }, (_, index) => ({
        id: `${id}-agent-${index}`,
        traceId: id,
        projectId,
        name: "agent invocation",
        kind: "task",
        groupType: "agent",
        groupName: name,
        groupVersion: version,
        status: "completed",
        startedAt,
        endedAt: "2026-09-01T12:00:01Z",
      }))
    )
    await db.insert(spans).values({
      id: `${id}-llm`,
      traceId: id,
      projectId,
      name: "completion",
      kind: "llm",
      status: "completed",
      startedAt,
      endedAt: "2026-09-01T12:00:01Z",
      attributesJson: JSON.stringify({ "cost.usd": cost }),
    })
  }
  const query = (
    model: string,
    measures: string[],
    groups: InvocationSelection[],
    day = false
  ) =>
    runTracerEffect(
      service.querySemanticMetrics({
        measures: measures.map((measure) => `${model}.${measure}`),
        timeDimensions: [
          {
            dimension: `${model}.startedAt`,
            dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
            ...(day ? { granularity: "day" } : {}),
          },
        ],
        filters: dashboardGroupFilters(model, groups),
        total: true,
      })
    )
  try {
    await insert("first", "Research", "v1", 2, 2)
    await insert("second", "Research", "v2", 6)
    await insert("other", "Other", "v1", 1)
    await insert("null-version", "Research", null, 3)
    const pool = new Pool({ connectionString: target.databaseUrl })
    try {
      await pool.query(
        "insert into project (id, organization_id, name, slug, created_at, updated_at) values ($1,$2,'Foreign','foreign',$3,$3)",
        ["foreign", target.organizationId, startedAt]
      )
    } finally {
      await pool.end()
    }
    await insert("foreign-trace", "Research", "v1", 8, 1, "foreign")
    const selected: InvocationSelection[] = [
      { type: "agent", name: "Research", versions: ["v1"] },
      { type: "workflow", name: "Briefing" },
    ]
    for (const day of [false, true]) {
      const result = await query(
        "logs",
        ["costUsd", "p95LatencyMs", "spanCount"],
        selected,
        day
      )
      expect(result.data[0]["logs.costUsd"]).toBe(2)
      expect(result.data[0]["logs.p95LatencyMs"]).toBe(2000)
      expect(result.data[0]["logs.spanCount"]).toBe(3)
      expect(
        (await query("traces", ["count"], selected, day)).data[0][
          "traces.count"
        ]
      ).toBe(1)
    }
    expect(
      (await query("agents", ["count", "p95DurationMs"], selected)).data[0][
        "agents.count"
      ]
    ).toBe(2)
    expect(
      (await query("workflows", ["count"], selected)).data[0]["workflows.count"]
    ).toBe(1)
    expect(
      (
        await query(
          "logs",
          ["costUsd"],
          [{ type: "agent", name: "Research", versions: ["v2"] }]
        )
      ).data[0]["logs.costUsd"]
    ).toBe(6)
    expect(
      (
        await query(
          "logs",
          ["costUsd"],
          [{ type: "agent", name: "Research", versions: [null] }]
        )
      ).data[0]["logs.costUsd"]
    ).toBe(3)
    expect(
      (await query("traces", ["count"], [{ type: "agent", name: "research" }]))
        .data[0]["traces.count"]
    ).toBe(0)
    const configuration = {
      schemaVersion: 1,
      name: "Filtered versions",
      description: "",
      widgets: [
        {
          id: "cost",
          title: "Cost",
          type: "line",
          width: 1,
          groups: [{ type: "agent", name: "Research", versions: ["v1", "v2"] }],
          compare: { type: "agent", name: "Research" },
          query: {
            measures: ["logs.costUsd"],
            timeDimensions: [
              {
                dimension: "logs.startedAt",
                granularity: "day",
                dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
              },
            ],
            filters: [
              {
                member: "logs.parent.metadata",
                path: ["environment"],
                operator: "equals",
                values: ["production"],
              },
              {
                member: "logs.parent.durationMs",
                operator: "gte",
                values: [2000],
              },
            ],
          },
        },
      ],
    }
    const saved = await runTracerEffect(
      service.dashboards.create(configuration)
    )
    const reloaded = await runTracerEffect(service.dashboards.get(saved.id))
    expect(reloaded.widgets[0].groups).toEqual(configuration.widgets[0].groups)
    expect(reloaded.widgets[0].compare).toEqual(
      configuration.widgets[0].compare
    )
    const preview = await runTracerEffect(
      service.agent.previewDashboard(saved.id)
    )
    expect(preview.results[0].data[0]["logs.costUsd"]).toBe(8)
    expect(
      preview.comparisons[0].cohorts.map(
        (cohort) => cohort.result.data[0]["logs.costUsd"]
      )
    ).toEqual([2, 6])
    const customMetric = await runTracerEffect(
      service.querySemanticMetrics({
        ...reloaded.widgets[0].query,
        filters: [
          {
            member: "logs.parent.metrics",
            path: ["quality"],
            operator: "gte",
            values: [6],
          },
        ],
      })
    )
    expect(customMetric.data[0]["logs.costUsd"]).toBe(6)
    expect(
      (
        await query(
          "traces",
          ["count"],
          [
            { type: "agent", name: "Research", versions: ["v2"] },
            { type: "agent", name: "Other", versions: ["v1"] },
          ]
        )
      ).data[0]["traces.count"]
    ).toBe(2)
    expect(
      (
        await query(
          "traces",
          ["count"],
          [
            { type: "agent", name: "Research" },
            { type: "workflow", name: "Missing" },
          ]
        )
      ).data[0]["traces.count"]
    ).toBe(0)
  } finally {
    await closeTracerDatabase(db)
    await target.close()
  }
}, 30000)

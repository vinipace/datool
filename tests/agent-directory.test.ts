import { afterEach, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import { getTracerProjectId, type TracerDatabase } from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import {
  agentDirectoryDimensions,
  performanceMeasures,
} from "@/src/lib/tracer/performance-table"
import type { SemanticQueryInput } from "@/src/lib/semantic"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"

let database: TracerDatabase | undefined
afterEach(async () => {
  if (database) await closeTracerFixture(database)
  database = undefined
})

test("agent directory merges created and traced identities before metrics and pagination without merging ambiguous names", async () => {
  database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId }
  const service = new TracerService(database)
  for (const agent of [
    {
      id: "support",
      name: "Support",
      slug: "support-slug",
      configuration: {
        appearance: {
          avatarUrl: "https://example.com/support.png",
          avatarStyle: "wink",
          avatarColor: "violet",
        },
      },
    },
    { id: "new-agent", name: "New agent", slug: "new-agent" },
    { id: "duplicate-a", name: "Same name", slug: "same-a" },
    { id: "duplicate-b", name: "Same name", slug: "same-b" },
  ])
    await createAgent(context, agent)
  for (const [id, name, agentId, duration] of [
    ["old", "old-support-name", "support", 100],
    ["new", "support-slug", null, 300],
    ["sdk", "External agent", null, 200],
    ["ambiguous", "Same name", null, 100],
    ["explicit", "Same name", "duplicate-a", 100],
  ] as const) {
    await runTracerEffect(
      service.createTrace({
        id,
        name,
        operation: "agent.run",
        group: { type: "agent", name, version: id },
        status: "completed",
        startedAt: "2026-10-29T12:00:00.000Z",
        endedAt: new Date(
          Date.parse("2026-10-29T12:00:00Z") + duration
        ).toISOString(),
        attributes: {
          ...(agentId ? { "build.agent.id": agentId } : {}),
          "cost.usd": 0.01,
        },
      })
    )
  }
  const foreignProjectId = crypto.randomUUID()
  await database.execute(sql`insert into project (id, organization_id, name, slug)
    select ${foreignProjectId}, organization_id, 'Other', 'other' from project where id = ${projectId}`)
  await database.execute(sql`insert into build_agents (project_id, id, name, slug, status, current_revision, applied_revision, current_config_json, applied_config_json, created_at, updated_at)
    select ${foreignProjectId}, 'hidden', 'Private agent', 'private', status, current_revision, applied_revision, current_config_json, applied_config_json, created_at, updated_at
    from build_agents where project_id = ${projectId} and id = 'support' `)
  const query: SemanticQueryInput = {
    measures: performanceMeasures.map((measure) => `agents.${measure}`),
    dimensions: agentDirectoryDimensions,
    timeDimensions: [
      {
        dimension: "agents.startedAt",
        dateRange: ["2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z"],
      },
    ],
    order: [
      ["agents.count", "desc"],
      ["agents.name", "asc"],
    ],
    total: true,
    limit: 50,
  }
  const result = await runTracerEffect(service.queryAgentDirectory(query))
  expect(result.meta.page.total).toBe(6)
  expect(
    result.data.filter((row) => row["agents.managedId"] === "support")
  ).toHaveLength(1)
  expect(
    result.data.find((row) => row["agents.managedId"] === "support")
  ).toMatchObject({
    "agents.name": "Support",
    "agents.count": 2,
    "agents.versionCount": 2,
    "agents.meanDurationMs": 200,
    "agents.p95DurationMs": 300,
    "agents.reportedCostUsd": 0.02,
    "agents.avatarUrl": "https://example.com/support.png",
    "agents.avatarStyle": "wink",
    "agents.avatarColor": "violet",
  })
  expect(
    result.data.find((row) => row["agents.managedId"] === "new-agent")
  ).toMatchObject({
    "agents.count": 0,
    "agents.meanDurationMs": null,
    "agents.reportedCostUsd": null,
    "agents.avatarUrl": null,
    "agents.avatarStyle": "friendly",
    "agents.avatarColor": "orange",
  })
  expect(
    result.data.find((row) => row["agents.name"] === "External agent")
  ).toMatchObject({
    "agents.avatarUrl": null,
    "agents.avatarStyle": null,
    "agents.avatarColor": null,
  })
  expect(
    result.data.filter((row) => row["agents.name"] === "Same name")
  ).toHaveLength(3)
  expect(
    result.data.some((row) => row["agents.name"] === "Private agent")
  ).toBe(false)
  const pages = []
  for (let offset = 0; offset < 6; offset += 2) {
    pages.push(
      ...(
        await runTracerEffect(
          service.queryAgentDirectory({ ...query, limit: 2, offset })
        )
      ).data
    )
  }
  expect(pages.map((row) => row["agents.identity"])).toEqual(
    result.data.map((row) => row["agents.identity"])
  )
  const filtered = await runTracerEffect(
    service.queryAgentDirectory({
      ...query,
      filters: [
        { member: "agents.name", operator: "equals", values: ["Support"] },
      ],
    })
  )
  expect(filtered.meta.page.total).toBe(1)
  expect(filtered.data[0]["agents.count"]).toBe(2)
  // The ordinary metrics API still groups instrumented names, for dashboards/SDK users.
  const performance = await runTracerEffect(
    service.querySemanticMetrics({ ...query, dimensions: ["agents.name"] })
  )
  expect(
    performance.data.some((row) => row["agents.name"] === "old-support-name")
  ).toBe(true)
}, 30_000)

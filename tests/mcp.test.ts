import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { agentOperations } from "../src/server/mcp/operations"
import { createMcpServer } from "../src/server/mcp/server"
import {
  verifyMcpToken,
  authFailure,
  checkOrigin,
  mcpScopes,
  resourceMetadata,
  type McpConfig,
} from "../src/server/mcp/auth"
import { evalRuns, traces } from "../src/server/tracer/schema"
import type { SemanticResult } from "../src/lib/semantic/result"
import { newDashboardWidget } from "../src/lib/tracer/dashboards"
import { semanticCatalog } from "../src/server/metrics/registry"
import { defaultScorer } from "../src/lib/tracer/scorers"

const config: McpConfig = {
  resource: "https://datool.example/api/mcp",
  issuer: "https://auth.example/",
  jwksUrl: "https://auth.example/jwks",
  origins: [],
}
test("OAuth verifies issuer, audience, expiry, signature, subject, scopes and origin", async () => {
  const pair = await generateKeyPair("RS256")
  const key = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] })
  const sign = (claims: Record<string, unknown> = {}) =>
    new SignJWT({
      scope: "scorers:read",
      projectId: "p",
      organizationId: "o",
      client_id: "c",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : config.issuer)
      .setAudience(
        typeof claims.aud === "string" ? claims.aud : config.resource
      )
      .setSubject(typeof claims.sub === "string" ? claims.sub : "owner")
      .setIssuedAt()
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
      .sign(pair.privateKey)
  expect((await verifyMcpToken(await sign(), config, key)).scopes).toEqual([
    "scorers:read",
  ])
  expect(
    (await verifyMcpToken(await sign({ scope: "metrics:read" }), config, key))
      .scopes
  ).toEqual(["metrics:read"])
  expect(resourceMetadata(config).scopes_supported).toContain("metrics:read")
  for (const token of [
    undefined,
    "invalid",
    await sign({ iss: "https://wrong.example" }),
    await sign({ aud: "another-api" }),
    await sign({ exp: 1 }),
    await sign({ projectId: null }),
    await sign({ scope: "openid" }),
  ]) {
    const outcome = await verifyMcpToken(token ?? "", config, key).then(
      () => "accepted",
      (error) => String(error)
    )
    expect(outcome === "accepted").toBe(false)
  }
  expect(() =>
    checkOrigin(
      new Request(config.resource, {
        headers: { origin: "https://evil.example" },
      }),
      config
    )
  ).toThrow()
  expect(resourceMetadata(config).resource).toBe(config.resource)
  const failure = authFailure(
    new (await import("../src/server/mcp/auth")).McpAuthError(
      "Missing token",
      401
    ),
    config
  )
  expect(failure.status).toBe(401)
  expect(failure.headers.get("WWW-Authenticate")).toContain(
    "oauth-protected-resource/api/mcp"
  )
})

test("MCP client performs CRUD and write tools are unavailable to read-only tokens", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  const clients: Client[] = []
  try {
    const service = new TracerService(db)
    async function connect(scopes: readonly string[]) {
      const server = createMcpServer(service, scopes)
      const client = new Client({ name: "test", version: "1" })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a)
      await client.connect(b)
      clients.push(client)
      return client
    }
    const client = await connect(mcpScopes)
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return (result.structuredContent as { data: Record<string, unknown> })
        .data
    }
    const listed = await client.listTools()
    expect(listed.tools.length).toBe(agentOperations.length)
    const metricsReader = await connect(["metrics:read"])
    const metricTools = (await metricsReader.listTools()).tools
    expect(metricTools.map((tool) => tool.name)).toEqual([
      "get_metrics_metadata",
      "query_metrics",
      "batch_metrics",
      "describe_agent_operations",
    ])
    expect(
      metricTools.every((tool) => tool.annotations?.readOnlyHint === true)
    ).toBe(true)
    const metadata = await metricsReader.callTool({
      name: "get_metrics_metadata",
      arguments: {},
    })
    expect(metadata.structuredContent).toEqual({
      data: semanticCatalog.metadata(),
    })
    await db.insert(traces).values({
      projectId: target.projectId,
      id: "mcp-metric-trace",
      name: "MCP metric fixture",
      status: "completed",
      operation: "mcp.test",
      startedAt: "2026-09-01T12:00:00.000Z",
    })
    const query = {
      measures: ["traces.count"],
      timeDimensions: [
        {
          dimension: "traces.startedAt",
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
        },
      ],
    }
    const queried = await metricsReader.callTool({
      name: "query_metrics",
      arguments: { query },
    })
    expect(queried.isError).not.toBe(true)
    const result = (queried.structuredContent as { data: SemanticResult }).data
    expect(result.data[0]["traces.count"]).toBe(1)
    expect(result.meta.contractVersion).toBe("datool-semantic-v2")
    const batched = await metricsReader.callTool({
      name: "batch_metrics",
      arguments: { queries: [query, query] },
    })
    expect(batched.isError).not.toBe(true)
    const batch = (batched.structuredContent as { data: SemanticResult[] }).data
    expect(batch).toHaveLength(2)
    expect(batch[0].data).toEqual(result.data)
    expect(batch[1].data).toEqual(result.data)
    expect(batch[0].meta.asOf).toBe(batch[1].meta.asOf)
    for (const args of [
      { query: {} },
      { query: { ...query, measures: ["traces.nonexistent"] } },
      { query: { ...query, sql: "SELECT 1" } },
    ]) {
      expect(
        (
          await metricsReader.callTool({
            name: "query_metrics",
            arguments: args,
          })
        ).isError
      ).toBe(true)
    }
    for (const queries of [[], Array(41).fill(query)]) {
      expect(
        (
          await metricsReader.callTool({
            name: "batch_metrics",
            arguments: { queries },
          })
        ).isError
      ).toBe(true)
    }
    const nonMetricsReader = await connect(["dashboards:read"])
    for (const [name, args] of [
      ["get_metrics_metadata", {}],
      ["query_metrics", { query }],
      ["batch_metrics", { queries: [query] }],
    ] as const) {
      expect(
        (await nonMetricsReader.callTool({ name, arguments: args })).isError
      ).toBe(true)
    }
    expect(
      (
        await metricsReader.callTool({
          name: "create_dataset",
          arguments: { name: "Denied" },
        })
      ).isError
    ).toBe(true)
    const scorer = await call("create_scorer", {
      scorer: {
        ...defaultScorer,
        name: "Test",
        slug: "test",
        type: "javascript",
      },
    })
    expect((await call("get_scorer", { id: scorer.id })).name).toBe("Test")
    await call("update_scorer", {
      id: scorer.id,
      expectedRevision: 1,
      scorer: {
        ...defaultScorer,
        name: "Updated",
        slug: "test",
        type: "javascript",
      },
    })
    expect((await call("get_scorer", { id: scorer.id })).revision).toBe(2)
    await call("delete_scorer", { id: scorer.id })
    const dataset = await call("create_dataset", { name: "Test dataset" })
    const item = await call("create_dataset_item", {
      datasetId: dataset.id,
      item: { input: "question", expectedOutput: "answer" },
    })
    await call("update_dataset_item", {
      id: item.id,
      patch: { expectedOutput: "updated" },
    })
    const detail = await call("get_dataset", { id: dataset.id })
    expect(
      (detail.items as { expectedOutput: string }[])[0].expectedOutput
    ).toBe("updated")
    await call("update_dataset", { id: dataset.id, patch: { name: "Renamed" } })
    await call("delete_dataset_item", { id: item.id })
    await call("delete_dataset", { id: dataset.id })
    const view = await call("create_saved_view", {
      name: "Trace name",
      resource: "traces",
      columns: [
        { id: "name", label: "Name", selector: "trace.name", format: "text" },
      ],
    })
    await call("update_saved_view", {
      id: view.id,
      patch: { name: "Renamed view" },
    })
    expect((await call("get_saved_view", { id: view.id })).name).toBe(
      "Renamed view"
    )
    await call("delete_saved_view", { id: view.id })
    const customInput = {
      name: "Review",
      resource: "eval-runs",
      settings: {
        schemaVersion: 1,
        computedColumns: [],
        columnOrder: [],
        columnVisibility: {},
        columnSizing: {},
        view: "table",
        detailsOpen: false,
      },
    }
    const custom = await call("create_view", customInput)
    await call("update_view", {
      ...customInput,
      id: custom.id,
      expectedRevision: 1,
      name: "Updated",
    })
    expect((await call("get_view", { id: custom.id })).revision).toBe(2)
    const stale = await client.callTool({
      name: "delete_view",
      arguments: { id: custom.id, expectedRevision: 1 },
    })
    expect(stale.isError).toBe(true)
    await call("delete_view", { id: custom.id, expectedRevision: 2 })
    const protectedDataset = await call("create_dataset", {
      name: "Historical dataset",
    })
    await db.insert(evalRuns).values({
      projectId: target.projectId,
      id: "historical-run",
      datasetId: String(protectedDataset.id),
      status: "completed",
      createdAt: new Date().toISOString(),
    })
    const protectedDelete = await client.callTool({
      name: "delete_dataset",
      arguments: { id: protectedDataset.id },
    })
    expect(protectedDelete.isError).toBe(true)
    expect((await call("get_dataset", { id: protectedDataset.id })).name).toBe(
      "Historical dataset"
    )
    const { handleMcp } = await import("../src/server/mcp/http")
    const dependencies = {
      config: () => config,
      authenticate: async () => ({
        subject: "owner",
        organizationId: target.organizationId,
        projectId: target.projectId,
        scopes: ["datasets:read"],
      }),
      service: async () => service,
    }
    const response = await handleMcp(
      new Request(config.resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      dependencies
    )
    expect(response.status).toBe(200)
    expect((await response.json()).result.tools.length).toBe(7)
    const dashboardConfig = {
      schemaVersion: 1,
      name: "MCP dashboard",
      description: "Test",
      widgets: [
        newDashboardWidget(
          semanticCatalog.metadata().models.find((m) => m.name === "traces")!,
          new Date("2026-09-07T12:00:00Z")
        ),
      ],
    }
    const dashboard = await call("create_dashboard", {
      config: dashboardConfig,
    })
    expect((await call("get_dashboard", { id: dashboard.id })).name).toBe(
      "MCP dashboard"
    )
    const dashboardsList = await client.callTool({
      name: "list_dashboards",
      arguments: {},
    })
    expect(
      (dashboardsList.structuredContent as { data: unknown[] }).data.length
    ).toBe(1)
    await call("update_dashboard", {
      id: dashboard.id,
      expectedRevision: 1,
      config: { ...dashboardConfig, name: "Updated dashboard" },
    })
    expect((await call("get_dashboard", { id: dashboard.id })).revision).toBe(2)
    for (const name of ["update_dashboard", "delete_dashboard"]) {
      const result = await client.callTool({
        name,
        arguments: {
          id: dashboard.id,
          expectedRevision: 1,
          ...(name === "update_dashboard" ? { config: dashboardConfig } : {}),
        },
      })
      expect(result.isError).toBe(true)
    }
    const dashboardReader = await connect(["dashboards:read"])
    expect(
      (await dashboardReader.listTools()).tools.map((t) => t.name)
    ).toEqual([
      "list_dashboards", "get_dashboard", "list_report_templates",
      "get_report_template", "get_report_recipe", "get_report_authoring_guide",
      "get_report_components", "resolve_dashboard", "describe_agent_operations",
    ])
    expect(
      (
        await dashboardReader.callTool({
          name: "delete_dashboard",
          arguments: { id: dashboard.id, expectedRevision: 2 },
        })
      ).isError
    ).toBe(true)
    await call("delete_dashboard", { id: dashboard.id, expectedRevision: 2 })
    expect(
      (
        await client.callTool({
          name: "get_dashboard",
          arguments: { id: dashboard.id },
        })
      ).isError
    ).toBe(true)
    const readonly = await connect(["datasets:read"])
    expect((await readonly.listTools()).tools.map((tool) => tool.name)).toEqual(
      ["list_datasets", "get_dataset", "list_dataset_items", "list_dataset_snapshots", "get_dataset_snapshot", "resolve_dataset", "describe_agent_operations"]
    )
    const denied = await readonly.callTool({
      name: "create_dataset",
      arguments: { name: "Denied" },
    })
    expect(denied.isError).toBe(true)
  } finally {
    await Promise.all(clients.map((c) => c.close()))
    await closeTracerDatabase(db)
    await target.close()
  }
})

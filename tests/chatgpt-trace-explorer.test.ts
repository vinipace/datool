import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { handleMcp } from "@/src/server/mcp/http"
import {
  McpAuthError,
  resourceMetadata,
  type McpConfig,
} from "@/src/server/mcp/auth"
import {
  createTraceExplorerServer,
  TRACE_EXPLORER_URI,
} from "@/src/server/mcp/trace-explorer"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { traces } from "@/src/server/tracer/schema"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import { evidenceContent } from "@/packages/chatgpt-trace-explorer/src/host"
import { createMcpTraceReadApi } from "@/packages/chatgpt-trace-explorer/src/trace-api"
import { createTraceDetailLoader } from "@/components/tracer/trace-detail-loader"
import type { ExplorerHost } from "@/packages/chatgpt-trace-explorer/src/host"
import type { Span } from "@/src/lib/tracer/contracts"

const config: McpConfig = {
  resource: "https://datool.example/api/mcp/trace-explorer",
  issuer: "https://datool.example/api/auth",
  jwksUrl: "https://datool.example/api/auth/jwks",
  origins: [],
  scopes: ["traces:read"],
}
function request(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return new Request(config.resource, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

test("public MCP discovery supplies UI/auth metadata but missing, expired and revoked credentials never access data", async () => {
  let serviceCalls = 0
  for (const authError of [
    new McpAuthError("Bearer access token required.", 401),
    new McpAuthError("Invalid or expired access token.", 401),
    new McpAuthError("OAuth consent or permissions have been revoked.", 403),
  ]) {
    const dependencies = {
      config: () => config,
      authenticate: async () => {
        throw authError
      },
      service: async (): Promise<TracerService> => {
        serviceCalls++
        throw new Error("Unauthorized service access")
      },
      publicServer: (error: McpAuthError) =>
        createTraceExplorerServer(null, config, error),
    }
    const discovery = await handleMcp(request("tools/list"), dependencies)
    expect(discovery.status).toBe(200)
    const tools = (await discovery.json()).result.tools
    const entry = tools.find(
      (tool: { name: string }) => tool.name === "open_trace_explorer"
    )
    expect(entry.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["traces:read"] },
    ])
    expect(entry._meta.securitySchemes).toEqual(entry.securitySchemes)
    expect(entry._meta.ui.resourceUri).toBe(TRACE_EXPLORER_URI)
    expect(
      tools.find((tool: { name: string }) => tool.name === "show_trace")._meta
        .ui.resourceUri
    ).toBe(TRACE_EXPLORER_URI)
    expect(entry._meta["openai/ui"].entrypoints).toEqual([{ type: "global" }])
    expect(
      tools.every(
        (tool: {
          annotations: { readOnlyHint: boolean; destructiveHint: boolean }
        }) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint
      )
    ).toBe(true)
    for (const name of ["open_trace_explorer", "list_traces", "get_trace"]) {
      const response = await handleMcp(
        request("tools/call", {
          name,
          arguments: name === "get_trace" ? { id: "private-trace" } : {},
        }),
        dependencies
      )
      const result = (await response.json()).result
      expect(result.isError).toBe(true)
      const challenge = result._meta["mcp/www_authenticate"][0]
      expect(challenge).toContain(
        "oauth-protected-resource/api/mcp/trace-explorer"
      )
      expect(challenge).toContain(
        `error="${authError.status === 403 ? "insufficient_scope" : "invalid_token"}"`
      )
      expect(challenge).toContain('error_description="')
      expect(result.structuredContent).toBeUndefined()
    }
    const resource = (
      await (
        await handleMcp(
          request("resources/read", { uri: TRACE_EXPLORER_URI }),
          dependencies
        )
      ).json()
    ).result.contents[0]
    expect(resource.mimeType).toBe("text/html;profile=mcp-app")
    expect(resource._meta.ui.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
    })
    expect(
      (
        await handleMcp(
          request("tools/list", {}, { origin: "https://evil.example" }),
          dependencies
        )
      ).status
    ).toBe(403)
  }
  expect(serviceCalls).toBe(0)
  expect(resourceMetadata(config).scopes_supported).toEqual(["traces:read"])
})

test("the plugin's real MCP transport pages and filters the granted project and reads only the selected trace/span", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const service = new TracerService(database)
  try {
    await database.execute(
      sql`insert into project(id,organization_id,name,slug) values('other-project',${target.organizationId},'Other project','other')`
    )
    await database.insert(traces).values({
      projectId: "other-project",
      id: "private-trace",
      name: "Must never be returned",
      operation: "test",
      status: "errored",
      startedAt: "2026-09-29T12:00:00Z",
    })
    await runTracerEffect(
      service.createTrace({
        id: "t1",
        name: "First failure",
        operation: "test",
        status: "errored",
        startedAt: "2026-09-29T12:00:00Z",
      })
    )
    await runTracerEffect(
      service.createTrace({
        id: "t2",
        name: "Second failure",
        operation: "test",
        status: "errored",
        startedAt: "2026-09-29T11:00:00Z",
      })
    )
    await runTracerEffect(
      service.createTrace({
        id: "t3",
        name: "Success",
        operation: "test",
        status: "completed",
        startedAt: "2026-09-29T10:00:00Z",
      })
    )
    await runTracerEffect(
      service.createSpan("t1", {
        id: "s1",
        name: "Model call",
        kind: "llm",
        input: { prompt: "Captured input" },
        output: { answer: "Captured output" },
        status: "errored",
        startedAt: "2026-09-29T12:00:00Z",
        endedAt: "2026-09-29T12:00:02Z",
      })
    )
    const dependencies = {
      config: () => config,
      authenticate: async () => ({
        subject: target.ownerId,
        organizationId: target.organizationId,
        projectId: target.projectId,
        scopes: ["traces:read", "traces:write"],
      }),
      service: async (projectId: string) => {
        expect(projectId).toBe(target.projectId)
        return service
      },
      createServer: (service: TracerService) =>
        createTraceExplorerServer(service, config),
    }
    async function call(name: string, args: Record<string, unknown> = {}) {
      const response = await handleMcp(
        request("tools/call", { name, arguments: args }),
        dependencies
      )
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    const first = (
      await call("open_trace_explorer", {
        filter: 'status = "errored"',
        limit: 1,
      })
    ).structuredContent.data
    expect(first.project).toEqual({
      id: target.projectId,
      name: "Test project",
      slug: "test-project",
    })
    expect(first.page.items.map((trace: { id: string }) => trace.id)).toEqual([
      "t1",
    ])
    expect(typeof first.page.nextCursor).toBe("string")
    const second = (
      await call("list_traces", {
        filter: 'status = "errored"',
        limit: 1,
        cursor: first.page.nextCursor,
      })
    ).structuredContent.data
    expect(second.items.map((trace: { id: string }) => trace.id)).toEqual([
      "t2",
    ])
    const shown = (await call("show_trace", { id: "t1" })).structuredContent
      .data
    expect(shown.trace.spans.map((span: { id: string }) => span.id)).toEqual([
      "s1",
    ])
    expect(shown.trace.spans[0].input).toBeUndefined()
    // The shared inspector reads complete evidence through MCP, without app HTTP.
    const api = createMcpTraceReadApi({
      call: async <T>(name: string, args: Record<string, unknown>) => {
        const result = await call(name, args)
        if (result.isError) throw new Error(result.content[0].text)
        return result.structuredContent.data as T
      },
    } as ExplorerHost)
    const loader = createTraceDetailLoader("t1", undefined, api, shown.trace)
    const overview = await loader.overview(new AbortController().signal)
    const detail = await loader.full(overview, new AbortController().signal)
    expect(detail.id).toBe("t1")
    expect(detail.spans[0].input).toEqual({ prompt: "Captured input" })
    expect(detail.spans[0].output).toEqual({ answer: "Captured output" })
    expect(detail.nextSpanCursor).toBeNull()
    expect(detail.scores).toEqual([])
    const captured = (
      await call("get_trace_span", { traceId: "t1", spanId: "s1" })
    ).structuredContent.data
    expect(captured.input).toEqual({ prompt: "Captured input" })
    expect(captured.output).toEqual({ answer: "Captured output" })
    for (const [name, args] of [
      ["get_trace", { id: "private-trace" }],
      ["show_trace", { id: "private-trace" }],
      ["get_trace_payload", { id: "private-trace" }],
      ["list_trace_scores", { id: "private-trace" }],
      ["get_trace_span", { traceId: "t2", spanId: "s1" }],
      ["open_trace_explorer", { projectId: "other-project" }],
      ["create_trace", { name: "Forbidden write" }],
    ] as const)
      expect((await call(name, args)).isError).toBe(true)
    const opened = await call("open_trace_explorer")
    expect(opened.isError).not.toBe(true)
  } finally {
    await closeTracerDatabase(database)
    await target.close()
  }
})

test("chat attachments contain selected captured evidence and bound large unicode payloads with an explicit truncation notice", () => {
  const span: Span = {
    id: "selected-span",
    traceId: "selected-trace",
    name: "Selected model call",
    parentId: null,
    kind: "llm",
    status: "errored",
    startedAt: "2026-09-29T12:00:00Z",
    endedAt: "2026-09-29T12:00:01Z",
    durationMs: 1000,
    input: "🧪".repeat(10000),
    output: "captured-output",
    attributes: {},
  }
  const evidence = {
    project: { id: "granted-project", name: "Project", slug: "project" },
    trace: {
      id: "selected-trace",
      name: "Trace",
      status: "errored" as const,
      startedAt: span.startedAt,
    },
    spans: [span],
  }
  const context = evidenceContent(evidence)
  expect(context.structuredContent.selectedSpanIds).toEqual(["selected-span"])
  expect(context.content).toHaveLength(1)
  expect(context.content[0].text).toContain("selected-trace")
  expect(context.content[0].text).toContain("Evidence truncated")
  expect(context.content[0].text).toContain("get_trace_span")
  expect(
    new TextEncoder().encode(
      JSON.stringify(
        evidenceContent({ ...evidence, spans: Array(10).fill(span) })
      )
    ).length
  ).toBeLessThan(64 * 1024)
})

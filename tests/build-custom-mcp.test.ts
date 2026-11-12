import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, expect, spyOn, test } from "bun:test"
import { Pool } from "pg"
import {
  createEveFixture,
  invokeTool,
  toolOutputs,
} from "./helpers/eve-fixture"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import * as publicHttp from "@/src/server/build/http"
import { saveMcpConnection } from "@/src/server/build/integrations/custom-mcp"
import {
  completeMcpOAuth,
  startMcpOAuth,
} from "@/src/server/build/integrations/mcp-oauth"
import { decryptProviderKey } from "@/src/server/model-providers/secrets"
import {
  disconnectApp,
  executeAppAction,
  listAppConnections,
  listAppTools,
  refreshAppConnection,
} from "@/src/server/build/integrations/service"
import { createAgent } from "@/src/server/build/agents"
import {
  listActions,
  getRuntimeAppliedDefinitions,
} from "@/src/server/build/definitions"
import { enableMcpTools } from "@/src/server/build/integrations/mcp-agent-tools"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { runAgentTurn } from "@/src/server/build/runtime"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

test("Datool agent calling its own MCP keeps one trace and one tool span", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["--no-env-file", "tests/helpers/mcp-agent-tracing.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          TEST_WORKSPACE: JSON.stringify(target),
          BETTER_AUTH_URL: "https://mcp.example.com",
          BETTER_AUTH_SECRET:
            "mcp-agent-trace-test-secret-at-least-32-characters",
          DATOOL_PROVIDER_ENCRYPTION_KEY:
            "mcp-agent-trace-encryption-at-least-32-characters",
          DATOOL_BUILD_ENABLED: "true",
          DATOOL_BILLING_ENABLED: "false",
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      }
    )
    expect(result.stdout).toContain("PASS agent MCP trace ownership")
  } finally {
    await target.close()
  }
}, 120_000)

async function fixture(jsonResponse: boolean, oauth = false) {
  const originalKey = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "custom-mcp-fixture-encryption-key-32-characters"
  cleanup.push(() => {
    if (originalKey === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = originalKey
  })
  const target = await createIsolatedPostgres()
  cleanup.push(target.close)
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const pool = new Pool({ connectionString: target.databaseUrl })
  cleanup.push(async () => {
    await closeTracerDatabase(database)
    await pool.end()
  })
  const context = {
    database,
    projectId: target.projectId,
    organizationId: target.organizationId,
    actorId: target.ownerId,
  }
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const calls: { token: string | null; url: string; method: string }[] = []
  const executions: string[] = []
  let available = true
  let acceptedToken = "oauth-access-one"
  const grants: URLSearchParams[] = []
  let beforeReply: (() => Promise<void>) | undefined
  const transport = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
    async (url, options = {}) => {
      calls.push({
        token: new Headers(options.headers).get("authorization"),
        url,
        method: options.method ?? "GET",
      })
      if (oauth) {
        const json = (value: unknown, status = 200) => ({
          url,
          status,
          headers: new Headers({ "content-type": "application/json" }),
          body: new TextEncoder().encode(JSON.stringify(value)),
        })
        if (url === "https://mcp.example.com/oauth/resource-metadata")
          return json({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://login.example.com"],
            scopes_supported: ["records:read", "records:write"],
          })
        if (
          url ===
          "https://login.example.com/.well-known/oauth-authorization-server"
        )
          return json({
            issuer: "https://login.example.com",
            authorization_endpoint: "https://login.example.com/authorize",
            token_endpoint: "https://login.example.com/token",
            registration_endpoint: "https://login.example.com/register",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          })
        if (url === "https://login.example.com/register")
          return json(
            {
              ...JSON.parse(String(options.body)),
              client_id: "registered-datool",
            },
            201
          )
        if (url === "https://login.example.com/token") {
          const grant = new URLSearchParams(String(options.body))
          grants.push(grant)
          return json({
            access_token: acceptedToken,
            token_type: "Bearer",
            refresh_token: "oauth-refresh-secret",
            expires_in: 3600,
          })
        }
        if (
          new Headers(options.headers).get("authorization") !==
          `Bearer ${acceptedToken}`
        ) {
          const response = json({ error: "unauthorized" }, 401)
          response.headers.set(
            "www-authenticate",
            'Bearer resource_metadata="https://mcp.example.com/oauth/resource-metadata", scope="records:read"'
          )
          return response
        }
      }
      if (!available) throw new Error("private upstream error: must-not-leak")
      const headers = new Headers(options.headers)
      const sessionId = headers.get("mcp-session-id")
      let session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        const server = new McpServer({ name: "Fixture", version: "1.0.0" })
        server.registerTool(
          oauth ? "superuser_list_projects" : "find-records.v1",
          { title: "Find records", inputSchema: { query: z.string() } },
          async ({ query }) => {
            executions.push(query)
            return { content: [{ type: "text", text: `Found: ${query}` }] }
          }
        )
        if (oauth)
          for (let index = 0; index < 12; index++) {
            server.registerTool(
              `superuser_prompt_groups_${index}`,
              {
                title: `List Prompt Groups ${index}`,
                description:
                  "List projects and their prompts for superuser operations.",
                inputSchema: { query: z.string() },
              },
              async () => {
                executions.push(`wrong-tool-${index}`)
                return {
                  content: [
                    {
                      type: "text",
                      text: "This is a prompt-group tool, not the requested project list.",
                    },
                  ],
                }
              }
            )
          }
        session = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: jsonResponse,
          onsessioninitialized: (id) => {
            sessions.set(id, session!)
          },
        })
        await server.connect(session)
        cleanup.push(() => server.close())
      }
      const response = await session.handleRequest(
        new Request(url, {
          method: options.method,
          headers,
          body: options.body as string | undefined,
        })
      )
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (beforeReply) {
        const action = beforeReply
        beforeReply = undefined
        await action()
      }
      return {
        url,
        status: response.status,
        headers: response.headers,
        body: bytes,
      }
    }
  )
  cleanup.push(() => transport.mockRestore())
  return {
    target,
    context,
    pool,
    calls,
    executions,
    grants,
    expireToken: () => {
      acceptedToken = "oauth-access-two"
    },
    setAvailable: (value: boolean) => {
      available = value
    },
    beforeReply: (action: () => Promise<void>) => {
      beforeReply = action
    },
  }
}

test("MCP OAuth: discovery, PKCE, one-use member-bound callback, encrypted tokens, refresh and disconnect", async () => {
  const f = await fixture(true, true)
  const originalOrigin = process.env.BETTER_AUTH_URL
  process.env.BETTER_AUTH_URL = "https://datool.example.com"
  cleanup.push(() => {
    if (originalOrigin === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = originalOrigin
  })
  const agent = await createAgent(f.context, {
    name: "OAuth agent",
    configuration: {
      provider: "openai",
      model: "gpt-4.1-mini",
      guardrails: { jevCheckEnabled: false },
    },
  })
  const started = await startMcpOAuth(f.context, {
    agentId: agent.id,
    name: "OAuth records",
    url: "https://mcp.example.com/mcp",
    returnTo: "/p/test-project/build/agents/agent?section=integrations",
  })
  const authorization = new URL(started.redirectUrl)
  expect(authorization.origin).toBe("https://login.example.com")
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    "https://datool.example.com/api/integrations/mcp/oauth/callback"
  )
  expect(authorization.searchParams.get("resource")).toBe(
    "https://mcp.example.com/mcp"
  )
  expect(authorization.searchParams.get("scope")).toBe("records:read")
  const state = authorization.searchParams.get("state")!
  expect((await refreshAppConnection(f.context, started.id)).status).toBe(
    "pending"
  )
  await assert.rejects(listAppTools(f.context, started.id), /unavailable/)
  await assert.rejects(
    completeMcpOAuth(
      { ...f.context, actorId: "another-user" },
      { state, code: "provider-code" }
    )
  )
  await assert.rejects(
    completeMcpOAuth(f.context, {
      state: state.slice(0, -1) + (state.endsWith("a") ? "b" : "a"),
      code: "provider-code",
    })
  )
  expect(f.grants).toHaveLength(0)
  const completed = await completeMcpOAuth(f.context, {
    state,
    code: "provider-code",
  })
  expect(completed).toEqual({
    success: true,
    returnTo: "/p/test-project/build/agents/agent?section=integrations",
  })
  const grant = f.grants[0]
  expect(grant.get("grant_type")).toBe("authorization_code")
  expect(grant.get("code")).toBe("provider-code")
  expect(
    createHash("sha256").update(grant.get("code_verifier")!).digest("base64url")
  ).toBe(authorization.searchParams.get("code_challenge")!)
  await assert.rejects(
    completeMcpOAuth(f.context, { state, code: "provider-code" })
  )
  const catalog = await listAppConnections(f.context)
  expect(catalog.connections[0]).toMatchObject({
    id: started.id,
    status: "active",
    authType: "oauth",
    hasToken: true,
  })
  expect(
    (await listAppConnections(f.context, agent.id)).connections[0]
      .agentToolCount
  ).toBe(13)
  expect(
    (
      await getRuntimeAppliedDefinitions(
        f.context,
        agent.id,
        agent.appliedRevision!
      )
    ).actions
  ).toHaveLength(0)
  expect(
    (await getRuntimeAppliedDefinitions(f.context, agent.id)).actions.some(
      (item) =>
        item.definition.type === "integration" &&
        item.definition.mcpToolName === "superuser_list_projects"
    )
  ).toBe(true)
  const otherAgent = await createAgent(f.context, { name: "Other agent" })
  expect(
    (await listAppConnections(f.context, otherAgent.id)).connections[0]
      .agentToolCount
  ).toBe(0)
  assert.doesNotMatch(
    JSON.stringify(catalog),
    /oauth-access|refresh-secret|verifier|registered-datool/
  )
  const row = (
    await f.pool.query(
      "SELECT mcp_config_encrypted FROM build_app_connections WHERE id=$1",
      [started.id]
    )
  ).rows[0]
  expect(row.mcp_config_encrypted).not.toContain("oauth-access")
  expect(
    JSON.parse(
      decryptProviderKey(
        row.mcp_config_encrypted,
        f.context.projectId,
        `build-mcp:${started.id}`
      )
    ).oauth.verifier
  ).toBeUndefined()
  f.expireToken()
  const concurrent = await Promise.all([
    listAppTools(f.context, started.id),
    listAppTools(f.context, started.id),
  ])
  expect(concurrent.map((tools) => tools.length)).toEqual([13, 13])
  expect(
    f.grants.filter((item) => item.get("grant_type") === "refresh_token")
  ).toHaveLength(1)
  expect(f.grants.at(-1)?.get("grant_type")).toBe("refresh_token")
  expect(f.grants.at(-1)?.get("refresh_token")).toBe("oauth-refresh-secret")
  expect(
    f.calls.some(
      (call) =>
        call.token === "Bearer oauth-access-two" &&
        call.url === "https://mcp.example.com/mcp"
    )
  ).toBe(true)
  expect(
    f.calls
      .filter((call) => call.url.startsWith("https://login.example.com"))
      .every((call) => !call.token)
  ).toBe(true)
  await saveMcpConnection(f.context, {
    connectionId: started.id,
    name: "Renamed",
    authType: "oauth",
  })
  const eve = await createEveFixture({
    target: f.target,
    upstream: (async (url, init) => {
      const result = await publicHttp.publicHttpRequest(String(url), {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      return new Response(new Uint8Array(result.body), {
        status: result.status,
        headers: result.headers,
      })
    }) as typeof fetch,
  })
  cleanup.push(() => eve.close())
  eve.provider((body) =>
    invokeTool(
      body,
      { query: "oauth probe" },
      "Found: oauth probe",
      "superuser_list_projects"
    )
  )
  const reply = await runAgentTurn(f.context, {
    agentId: agent.id,
    channel: "api",
    requestKey: "oauth-tool-execution",
    message: "Find oauth probe",
  })
  expect(reply.toolCalls[0]?.status).toBe("completed")
  expect(f.executions).toEqual(["oauth probe"])
  f.setAvailable(false)
  const failed = await runAgentTurn(f.context, {
    agentId: agent.id,
    channel: "api",
    requestKey: "oauth-tool-failure-context",
    message: "Find oauth probe",
  })
  expect(failed.toolCalls[0]?.error).toMatchObject({
    kind: "MCP_HTTP_ERROR",
    details: { stage: "transport", httpStatus: 500 },
  })
  const trace = await runTracerEffect(
    new TracerService(f.context.database).getTrace(failed.traceId!)
  )
  const failedSpan = trace.spans.find(
    (span) => span.kind === "tool" && span.status === "errored"
  )
  expect(failedSpan?.attributes["error.type"]).toBe("MCP_HTTP_ERROR")
  expect(failedSpan?.attributes["error.message"]).toBe(
    "The MCP server returned HTTP 500. Check the server connection before retrying."
  )
  assert.doesNotMatch(
    JSON.stringify({ trace, feedback: toolOutputs(eve.requests.at(-1)!) }),
    /must-not-leak|oauth-refresh-secret|oauth-access-two/
  )
  f.setAvailable(true)
  await disconnectApp(f.context, started.id)
  expect((await listAppConnections(f.context)).connections[0].status).toBe(
    "disconnected"
  )
  expect(
    (
      await f.pool.query(
        "SELECT mcp_config_encrypted FROM build_app_connections WHERE id=$1",
        [started.id]
      )
    ).rows[0].mcp_config_encrypted
  ).toBeNull()
  await assert.rejects(listAppTools(f.context, started.id), /unavailable/)
}, 30_000)

test("MCP OAuth: cancellation, expiry and disconnect cannot activate a pending account", async () => {
  const f = await fixture(true, true)
  const start = () =>
    startMcpOAuth(f.context, {
      name: "Records",
      url: "https://mcp.example.com/mcp",
      returnTo: "/p/test-project",
    })
  const first = await start()
  const state = new URL(first.redirectUrl).searchParams.get("state")!
  expect(
    (await completeMcpOAuth(f.context, { state, denied: true })).success
  ).toBe(false)
  expect((await listAppConnections(f.context)).connections[0]).toMatchObject({
    status: "failed",
    hasToken: false,
  })
  const expired = await start()
  await f.pool.query(
    "UPDATE build_mcp_oauth_requests SET expires_at=now()-interval '1 minute' WHERE connection_id=$1",
    [expired.id]
  )
  await assert.rejects(
    completeMcpOAuth(f.context, {
      state: new URL(expired.redirectUrl).searchParams.get("state")!,
      code: "code",
    })
  )
  const disconnected = await start()
  await disconnectApp(f.context, disconnected.id)
  await assert.rejects(
    completeMcpOAuth(f.context, {
      state: new URL(disconnected.redirectUrl).searchParams.get("state")!,
      code: "code",
    })
  )
  expect(f.grants).toHaveLength(0)
}, 30_000)

for (const jsonResponse of [true, false]) {
  test(`custom MCP ${jsonResponse ? "JSON" : "SSE"}: encrypted accounts, agent tool loop and revocation`, async () => {
    const f = await fixture(jsonResponse)
    const connection = await saveMcpConnection(f.context, {
      name: "Records",
      url: "https://mcp.example.com/mcp?key=query-secret",
      token: "first-secret",
    })
    const catalog = await listAppConnections(f.context)
    expect(catalog.connections).toEqual([connection])
    expect(connection.mcpUrl).toBe("https://mcp.example.com/mcp")
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /first-secret|query-secret|mcp_config_encrypted/
    )
    const stored = await f.pool.query(
      "SELECT mcp_config_encrypted FROM build_app_connections WHERE id=$1",
      [connection.id]
    )
    assert.doesNotMatch(
      stored.rows[0].mcp_config_encrypted,
      /first-secret|query-secret/
    )
    expect(
      f.calls.some(
        (call) =>
          call.token === "Bearer first-secret" &&
          call.url.includes("query-secret")
      )
    ).toBe(true)
    const tools = await listAppTools(f.context, connection.id)
    expect(tools[0]).toMatchObject({
      name: "Find records",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    })
    const agent = await createAgent(f.context, {
      name: "Records agent",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        guardrails: { jevCheckEnabled: false },
      },
    })
    expect(
      (await enableMcpTools(f.context, agent.id, connection.id)).imported
    ).toBe(1)
    expect(
      (await enableMcpTools(f.context, agent.id, connection.id)).imported
    ).toBe(0)
    const [action] = await listActions(f.context, agent.id)
    expect(action.definition.inputSchema).toMatchObject({ required: ["query"] })
    expect(action.definition.name).toBe("Records: Find records")
    const eve = await createEveFixture({
      target: f.target,
      upstream: (async (url, init) => {
        const result = await publicHttp.publicHttpRequest(String(url), {
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: typeof init?.body === "string" ? init.body : undefined,
        })
        return new Response(new Uint8Array(result.body), {
          status: result.status,
          headers: result.headers,
        })
      }) as typeof fetch,
    })
    cleanup.push(() => eve.close())
    eve.provider((body) => {
      if (toolOutputs(body).length === 2)
        expect(JSON.stringify(toolOutputs(body))).toContain("Found: hello")
      return invokeTool(body, { query: "hello" }, "Found: hello", "records")
    })
    const options = {}
    const request = {
      agentId: agent.id,
      channel: "api" as const,
      requestKey: "mcp-agent-turn",
      message: "Find hello",
    }
    const result = await runAgentTurn(f.context, request, options)
    expect(result.status).toBe("completed")
    expect(result.text).toBe("Found: hello")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({
      actionId: action.id,
      status: "completed",
      output: { content: [{ type: "text", text: "Found: hello" }] },
    })
    const replay = await runAgentTurn(
      f.context,
      { ...request, conversationId: result.conversation.id },
      options
    )
    expect(replay.replayed).toBe(true)
    expect(eve.requests).toHaveLength(3)
    const input = {
      agentId: agent.id,
      conversationId: result.conversation.id,
      turnId: result.turn.id,
      toolCallId: result.toolCalls[0].toolCallId,
      connectionId: connection.id,
      toolSlug: tools[0].slug,
      arguments: { query: "hello" },
    }
    await assert.rejects(
      executeAppAction(f.context, input),
      /already attempted/
    )
    expect(f.executions).toEqual(["hello"])
    const usage = await f.pool.query(
      "SELECT provider,status,cost_nano_usd FROM build_usage_event WHERE connection_id=$1",
      [connection.id]
    )
    expect(usage.rows).toEqual([
      { provider: "mcp", status: "completed", cost_nano_usd: "0" },
    ])
    f.calls.length = 0
    await saveMcpConnection(f.context, {
      connectionId: connection.id,
      name: "Renamed records",
    })
    expect(
      f.calls.some(
        (call) =>
          call.token === "Bearer first-secret" &&
          call.url.includes("query-secret")
      )
    ).toBe(true)
    await saveMcpConnection(f.context, {
      connectionId: connection.id,
      name: "Renamed records",
      token: "second-secret",
    })
    expect(f.calls.at(-1)?.token).toBe("Bearer second-secret")
    f.setAvailable(false)
    expect((await refreshAppConnection(f.context, connection.id)).status).toBe(
      "failed"
    )
    f.setAvailable(true)
    expect((await refreshAppConnection(f.context, connection.id)).status).toBe(
      "active"
    )
    await disconnectApp(f.context, connection.id)
    expect((await refreshAppConnection(f.context, connection.id)).status).toBe(
      "disconnected"
    )
    await assert.rejects(listAppTools(f.context, connection.id), /unavailable/)
    await assert.rejects(
      executeAppAction(f.context, {
        ...input,
        toolCallId: crypto.randomUUID(),
      }),
      /unavailable/
    )
    expect(
      (
        await f.pool.query(
          "SELECT mcp_config_encrypted FROM build_app_connections WHERE id=$1",
          [connection.id]
        )
      ).rows[0].mcp_config_encrypted
    ).toBeNull()
  }, 30_000)
}

test("custom MCP rejects private endpoints and foreign accounts, and a delayed save cannot undo disconnect", async () => {
  const f = await fixture(true)
  for (const url of [
    "http://public.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/mcp",
    "https://user:secret@public.example.com/mcp",
  ]) {
    await assert.rejects(saveMcpConnection(f.context, { name: "Unsafe", url }))
  }
  expect(f.calls).toHaveLength(0)
  const connection = await saveMcpConnection(f.context, {
    name: "Records",
    url: "https://mcp.example.com/mcp",
    token: "secret",
  })
  await f.pool.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES('foreign-project',$1,'Foreign','foreign')",
    [f.target.organizationId]
  )
  await f.pool.query(
    "UPDATE build_app_connections SET project_id='foreign-project' WHERE id=$1",
    [connection.id]
  )
  await assert.rejects(
    saveMcpConnection(f.context, {
      name: "Foreign",
      connectionId: connection.id,
    }),
    /not found/
  )
  await assert.rejects(listAppTools(f.context, connection.id), /unavailable/)
  await f.pool.query(
    "UPDATE build_app_connections SET project_id=$1 WHERE id=$2",
    [f.context.projectId, connection.id]
  )
  f.beforeReply(async () => {
    await disconnectApp(f.context, connection.id)
  })
  await assert.rejects(
    saveMcpConnection(f.context, {
      name: "Delayed edit",
      connectionId: connection.id,
    }),
    /changed/
  )
  expect((await listAppConnections(f.context)).connections[0].status).toBe(
    "disconnected"
  )
  expect(
    (
      await saveMcpConnection(f.context, {
        name: "Reconnected",
        connectionId: connection.id,
        url: "https://mcp.example.com/mcp",
        token: "",
      })
    ).hasToken
  ).toBe(false)
}, 30_000)

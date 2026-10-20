import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Pool } from "pg"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction } from "@/src/server/build/definitions"
import { ConversationService } from "@/src/server/build/conversations"
import { runAgentTurn } from "@/src/server/build/runtime"
import {
  connectApp,
  disconnectApp,
  executeAppAction,
  listAppConnections,
  listAppTools,
  refreshAppConnection,
} from "@/src/server/build/integrations/service"
import { getAgentUsage } from "@/src/server/build/usage"
import { ExecutionCreditStore } from "@/src/server/execution-credits/ledger"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

const cleanup: (() => Promise<void>)[] = []
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of [
    "COMPOSIO_API_KEY",
    "DATOOL_COMPOSIO_APPS",
    "DATOOL_BILLING_ENABLED",
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(costNanoUsd = 2_000_000_000, connectionCostNanoUsd = 0) {
  process.env.DATOOL_BILLING_ENABLED = "false"
  process.env.COMPOSIO_API_KEY = "fixture-only-key"
  process.env.DATOOL_COMPOSIO_APPS = JSON.stringify({
    googlecalendar: {
      name: "Google Calendar",
      authConfigId: "ac_calendar",
      costNanoUsd,
      connectionCostNanoUsd,
      tools: ["GOOGLECALENDAR_EVENTS_LIST"],
    },
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
  }
  const agent = await createAgent(context, {
    id: "agent-calendar",
    name: "Calendar assistant",
    configuration: { model: "test-model", provider: "openai" },
  })
  const service = new ConversationService(context)
  const requests: { path: string; body: Record<string, unknown> }[] = []
  let mode: "completed" | "failed" | "network" = "completed"
  let account = 0
  let connectionFails = false
  globalThis.fetch = (async (
    request: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request)
    )
    assert.equal(
      url.hostname,
      "backend.composio.dev",
      "Tests must not contact a real provider"
    )
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/tool_router/session"))
      return Response.json({
        session_id: "session_fixture",
        config: {},
        mcp: { type: "http", url: "https://backend.composio.dev/mcp" },
      })
    if (url.pathname.endsWith("/link")) {
      if (connectionFails)
        throw new TypeError("fixture authorization connection lost")
      return Response.json({
        connected_account_id: `ca_fixture_${++account}`,
        redirect_url: "https://connect.composio.dev/fixture",
      })
    }
    if (
      url.pathname.includes("/connected_accounts/") &&
      init?.method !== "DELETE"
    )
      return Response.json({
        id: url.pathname.split("/").pop(),
        status: "ACTIVE",
        status_reason: null,
        toolkit: { slug: "googlecalendar" },
        auth_config: {
          id: "ac_calendar",
          auth_scheme: "OAUTH2",
          is_composio_managed: true,
          is_disabled: false,
        },
        is_disabled: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        data: { access_token: "must-never-leak" },
      })
    if (
      url.pathname.includes("/connected_accounts/") &&
      init?.method === "DELETE"
    )
      return Response.json({ success: true })
    if (url.pathname.endsWith("/tools"))
      return Response.json({
        items: [
          {
            slug: "GOOGLECALENDAR_EVENTS_LIST",
            name: "List events",
            description: "List calendar events",
            toolkit: { slug: "googlecalendar", name: "Google Calendar" },
            input_parameters: {
              type: "object",
              properties: { calendar_id: { type: "string" } },
              required: ["calendar_id"],
            },
            output_parameters: { type: "object" },
            version: "20261020_00",
            tags: [],
          },
        ],
        total_pages: 1,
      })
    if (url.pathname.endsWith("/execute")) {
      if (mode === "network") throw new TypeError("fixture connection lost")
      return Response.json({
        result_type: mode,
        data: { events: [] },
        error: null,
        log_id: `log_${requests.length}`,
      })
    }
    throw new Error(`Unexpected provider path: ${url.pathname}`)
  }) as typeof fetch
  async function connected() {
    const connection = await connectApp(
      { ...context, idempotencyKey: crypto.randomUUID() },
      "googlecalendar"
    )
    await refreshAppConnection(context, connection.id)
    return connection.id
  }
  async function invocation(connectionId: string) {
    const conversation = await service.getOrCreate({
      agentId: agent.id,
      channel: "api",
      metadata: {},
    })
    const admission = await service.startTurn(conversation.id, {
      requestKey: crypto.randomUUID(),
      input: "Calendar",
      metadata: {},
      snapshot: {},
    })
    return {
      connectionId,
      toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
      agentId: agent.id,
      conversationId: conversation.id,
      turnId: admission.turn.id,
      toolCallId: crypto.randomUUID(),
      arguments: { calendar_id: "primary" },
    }
  }
  async function funded() {
    await pool.query(
      `INSERT INTO organization_billing(organization_id,subscription_id,price_id,status,access_until,checkout_attempt_id) VALUES($1,'sub','price_core','active',now()+interval '30 days','attempt')`,
      [target.organizationId]
    )
    const credits = new ExecutionCreditStore(pool)
    await credits.grant({
      organizationId: target.organizationId,
      subscriptionId: "sub",
      invoiceId: "invoice",
      start: new Date(Date.now() - 1000),
      end: new Date(Date.now() + 86400000 * 30),
      plan: "core",
    })
    process.env.DATOOL_BILLING_ENABLED = "true"
    return credits
  }
  return {
    target,
    pool,
    context,
    agent,
    service,
    requests,
    connected,
    invocation,
    funded,
    setConnectionFailure: (value: boolean) => {
      connectionFails = value
    },
    setMode: (value: typeof mode) => {
      mode = value
    },
  }
}

test("project connections authorize privately, reject cross-tenant access and replays, and revoke applied actions", async () => {
  const f = await fixture(2_000_000_000, 1_000_000_000)
  const credits = await f.funded()
  const ctx = { ...f.context, idempotencyKey: "connect-once" }
  const connection = await connectApp(ctx, "googlecalendar")
  expect((await credits.usage(f.target.organizationId)).integration).toBe(1)
  const firstRequest = f.requests[0].body
  expect(firstRequest.toolkits).toEqual({ enable: ["googlecalendar"] })
  expect(firstRequest.workbench).toEqual({ enable: false })
  expect(firstRequest.proxy_execute).toEqual({ enable: false })
  const requestCount = f.requests.length
  await assert.rejects(connectApp(ctx, "googlecalendar"), /already attempted/)
  await assert.rejects(
    refreshAppConnection(
      { ...ctx, organizationId: "different-customer" },
      connection.id
    ),
    /outside/
  )
  expect(f.requests.length).toBe(requestCount)
  await refreshAppConnection(ctx, connection.id)
  expect(JSON.stringify(await listAppConnections(ctx))).not.toContain(
    "must-never-leak"
  )
  expect(
    (await listAppTools(ctx, connection.id))[0].inputSchema.required
  ).toEqual(["calendar_id"])
  // Same database, different project: lookup must fail before any provider request.
  await f.pool.query(
    `INSERT INTO project(id,organization_id,name,slug) VALUES('other-project',$1,'Other','other')`,
    [f.target.organizationId]
  )
  await assert.rejects(
    listAppTools({ ...ctx, projectId: "other-project" }, connection.id),
    /unavailable/
  )
  await disconnectApp(ctx, connection.id)
  const calls = f.requests.length
  await assert.rejects(
    executeAppAction(ctx, await f.invocation(connection.id)),
    /unavailable/
  )
  expect(f.requests.length).toBe(calls)
}, 30000)

test("concurrent app calls share tier credits, rejected calls never dispatch, and retries never spend twice", async () => {
  const f = await fixture()
  const connection = await f.connected()
  const credits = await f.funded()
  const attempts = await Promise.all([
    f.invocation(connection),
    f.invocation(connection),
    f.invocation(connection),
  ])
  const results = await Promise.allSettled(
    attempts.map((input) => executeAppAction(f.context, input))
  )
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
  expect(f.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(2)
  expect((await credits.usage(f.target.organizationId)).integration).toBe(4)
  await assert.rejects(
    executeAppAction(f.context, attempts[0]),
    /already attempted/
  )
  expect(f.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(2)
  const usage = await getAgentUsage(f.target.organizationId, {}, f.pool)
  expect(usage.totals.integrationCalls).toBe(2)
  expect(usage.totals.integrationCostUsd).toBe(4)
  expect(usage.agents[0].agentId).toBe(f.agent.id)
  expect(usage.conversations).toHaveLength(3)
  expect(
    (await getAgentUsage("another-customer", {}, f.pool)).totals
      .integrationCalls
  ).toBe(0)
}, 30000)

test("uncertain app outcomes keep reservations, known failures are metered, and disabled billing still records usage", async () => {
  const f = await fixture(1_000_000_000)
  const connection = await f.connected()
  const credits = await f.funded()
  f.setMode("network")
  await assert.rejects(
    executeAppAction(f.context, await f.invocation(connection)),
    /uncertain/
  )
  expect(f.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1)
  expect((await credits.usage(f.target.organizationId)).reserved).toBe(1)
  f.setMode("failed")
  expect(
    (await executeAppAction(f.context, await f.invocation(connection))).status
  ).toBe("failed")
  expect((await credits.usage(f.target.organizationId)).used).toBe(1)
  process.env.DATOOL_BILLING_ENABLED = "false"
  f.setMode("completed")
  await executeAppAction(f.context, await f.invocation(connection))
  expect((await credits.usage(f.target.organizationId)).used).toBe(1)
  const usage = await getAgentUsage(f.target.organizationId, {}, f.pool)
  expect(usage.totals.integrationCalls).toBe(3)
  expect(usage.totals.pendingCalls).toBe(1)
  const pending = await f.pool.query(
    "SELECT id FROM execution_credit_operation WHERE state='reserved'"
  )
  await credits.settle(pending.rows[0].id, 0, "verified-log", {
    result: "completed",
    reconciliation: { reason: "Provider confirmed an unbilled execution." },
  })
  const reconciled = await getAgentUsage(f.target.organizationId, {}, f.pool)
  expect(reconciled.totals.pendingCalls).toBe(0)
  expect(reconciled.totals.integrationCalls).toBe(3)
  expect(reconciled.totals.integrationCostUsd).toBe(2)
  expect((await credits.usage(f.target.organizationId)).reserved).toBe(0)
}, 30000)

test("real agent tool loop records each model call and integration with agent/conversation attribution and replays safely", async () => {
  const f = await fixture(1_000_000)
  const connectionId = await f.connected()
  const action = await saveAction(f.context, f.agent.id, {
    id: "calendar",
    slug: "calendar",
    definition: {
      type: "integration",
      id: "calendar",
      name: "Calendar",
      connectionId,
      toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
    },
  })
  expect(action.definition.inputSchema.required).toEqual(["calendar_id"])
  await updateAgent(f.context, f.agent.id, {
    expectedRevision: f.agent.currentRevision,
    apply: true,
  })
  const model = new MockLanguageModelV4({
    modelId: "test-model",
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "calendar-1",
            toolName: "calendar",
            input: '{"calendar_id":"primary"}',
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 20, noCache: 16, cacheRead: 4, cacheWrite: 0 },
          outputTokens: { total: 6, text: 4, reasoning: 2 },
        },
        warnings: [],
      },
      {
        content: [{ type: "text", text: "No events." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 30, noCache: 25, cacheRead: 5, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
      },
    ],
  })
  const options = {
    dependencies: {
      generateText: ((options) =>
        generateText({ ...options, model })) as typeof generateText,
    },
  }
  const input = {
    agentId: f.agent.id,
    channel: "api" as const,
    requestKey: "calendar-turn",
    message: "What is on my calendar?",
  }
  const result = await runAgentTurn(f.context, input, options)
  expect(result.status).toBe("completed")
  expect(f.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1)
  const usage = await getAgentUsage(f.target.organizationId, {}, f.pool)
  expect(usage.totals.inputTokens).toBe(50)
  expect(usage.totals.outputTokens).toBe(9)
  expect(usage.totals.cachedInputTokens).toBe(9)
  expect(usage.totals.reasoningTokens).toBe(2)
  expect(usage.totals.modelCalls).toBe(2)
  expect(usage.totals.unpricedModelCalls).toBe(2)
  expect(usage.conversations[0].conversationId).toBe(result.conversation.id)
  await runAgentTurn(
    f.context,
    { ...input, conversationId: result.conversation.id },
    options
  )
  expect(
    (await getAgentUsage(f.target.organizationId, {}, f.pool)).totals.modelCalls
  ).toBe(2)
  expect(f.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1)
}, 30000)

test("a later model failure preserves earlier token usage and exposes the missing report", async () => {
  const f = await fixture()
  let calls = 0
  const model = new MockLanguageModelV4({
    modelId: "test-model",
    doGenerate: async () => {
      if (++calls === 2) throw new Error("provider unavailable")
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "unknown-tool",
            toolName: "missing",
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 17, noCache: 17, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  await assert.rejects(
    runAgentTurn(
      f.context,
      {
        agentId: f.agent.id,
        channel: "api",
        requestKey: "partial-failure",
        message: "Check the calendar.",
      },
      {
        dependencies: {
          generateText: (options) => generateText({ ...options, model }),
        },
      }
    ),
    /model request failed/
  )
  const usage = await getAgentUsage(f.target.organizationId, {}, f.pool)
  expect(usage.totals.modelCalls).toBe(2)
  expect(usage.totals.inputTokens).toBe(17)
  expect(usage.totals.outputTokens).toBe(4)
  expect(usage.totals.missingTokenCalls).toBe(1)
  expect(usage.totals.pendingCalls).toBe(1)
}, 30000)

test("OAuth initiation is charged once, retains uncertain credit, and cannot exceed the shared balance", async () => {
  const f = await fixture(1_000_000_000, 2_000_000_000)
  const credits = await f.funded()
  f.setConnectionFailure(true)
  await assert.rejects(
    connectApp(
      { ...f.context, idempotencyKey: "failed-link" },
      "googlecalendar"
    ),
    /Unable to confirm/
  )
  expect(f.requests.filter((r) => r.path.endsWith("/link"))).toHaveLength(1)
  expect((await credits.usage(f.target.organizationId)).reserved).toBe(2)
  f.setConnectionFailure(false)
  await connectApp(
    { ...f.context, idempotencyKey: "successful-link" },
    "googlecalendar"
  )
  await assert.rejects(
    connectApp(
      { ...f.context, idempotencyKey: "unfunded-link" },
      "googlecalendar"
    ),
    /execution credits/
  )
  expect(f.requests.filter((r) => r.path.endsWith("/link"))).toHaveLength(2)
  const usage = await credits.usage(f.target.organizationId)
  expect(usage.integration).toBe(2)
  expect(usage.reserved).toBe(2)
  expect(usage.remaining).toBe(1)
}, 30000)

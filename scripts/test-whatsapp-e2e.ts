/** Isolated integration proof: real HTTP ingress, MCP, PostgreSQL and runtime.
 * Meta and model responses are simulated; the HTTP action uses synthetic data
 * against Postman's echo service. No WhatsApp number or customer is contacted. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createHmac, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"

const target = await createIsolatedPostgres()
let pools: typeof import("../lib/db") | undefined
let server: ReturnType<typeof createServer> | undefined
const clients: Client[] = []
const servers: Array<{ close(): Promise<void> }> = []
const originalFetch = globalThis.fetch
const checkpoints: string[] = []
const passed = (name: string) => {
  checkpoints.push(name)
  console.log(`PASS ${name}`)
}
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_SECRET: "b".repeat(64),
    DATOOL_META_APP_ID: "10000000001",
    DATOOL_META_APP_SECRET: "synthetic-app-secret",
    DATOOL_META_WHATSAPP_CONFIG_ID: "10000000002",
    DATOOL_META_WEBHOOK_VERIFY_TOKEN: "synthetic-verification-token",
    DATOOL_PUBLIC_URL: "https://datool.example.test",
    DATOOL_META_GRAPH_VERSION: "v23.0",
  })
  pools = await import("../lib/db")
  const { createTracerDatabase } = await import("../src/server/tracer/db")
  const { createMcpServer } = await import("../src/server/mcp/server")
  const { TracerService } = await import("../src/server/tracer/service")
  const { withWorkspace } = await import("../src/server/auth/context")
  const { runAgentTurn } = await import("../src/server/build/runtime")
  const { runQueuedKnowledgeJobs } =
    await import("../src/server/build/knowledge")
  const channels = await import("../src/server/build/channels/service")
  const whatsapp = await import("../src/server/build/channels/whatsapp")
  const route = await import("../app/api/build-webhooks/whatsapp/route")
  const { ConversationService } =
    await import("../src/server/build/conversations")
  const database = createTracerDatabase(undefined, {
    projectId: target.projectId,
  })
  const context = {
    database,
    projectId: target.projectId,
    organizationId: target.organizationId,
    actorId: target.ownerId,
  }
  const identity = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    userId: target.ownerId,
    kind: "session" as const,
    scopes: ["build:read", "build:write", "build:run"],
  }
  async function connect(scopes = identity.scopes) {
    const mcp = createMcpServer(new TracerService(database), scopes)
    const client = new Client({ name: "whatsapp-e2e", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    await client.connect(b)
    clients.push(client)
    servers.push(mcp)
    return client
  }
  const client = await connect()
  async function call<T = Record<string, unknown>>(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<T> {
    const result = await withWorkspace(identity, () =>
      client.callTool({
        name,
        arguments: {
          ...input,
          ...(!/build_(get|list)_/.test(name)
            ? { idempotencyKey: input.idempotencyKey ?? randomUUID() }
            : {}),
        },
      })
    )
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return (result.structuredContent as { data: T }).data
  }
  const readOnly = await connect(["build:read"])
  const denied = await withWorkspace(
    { ...identity, scopes: ["build:read"] },
    () =>
      readOnly.callTool({
        name: "build_begin_whatsapp_signup",
        arguments: {
          connectionId: randomUUID(),
          mode: "coexistence",
          idempotencyKey: randomUUID(),
        },
      })
  )
  assert.equal(denied.isError, true)
  const ready = await call("build_get_whatsapp_setup")
  assert.equal(ready.configured, true)
  assert(!JSON.stringify(ready).includes(process.env.DATOOL_META_APP_SECRET!))
  passed("MCP readiness and read-only permission boundary")

  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(incoming.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
      })
      const result =
        incoming.method === "GET"
          ? await route.GET(request)
          : await route.POST(request)
      outgoing.writeHead(result.status, Object.fromEntries(result.headers))
      outgoing.end(Buffer.from(await result.arrayBuffer()))
    } catch {
      outgoing.writeHead(500)
      outgoing.end("Test server error")
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/build-webhooks/whatsapp`

  const waba = "20000000001",
    phone = "30000000001",
    recipient = "5511999990001"
  const accessToken = "synthetic-customer-token-do-not-return"
  let appMismatch = false,
    sendFailure = false,
    providerCalls = 0,
    sendCalls = 0,
    registerCalls = 0
  let isBusinessApp = true,
    listedPhone = phone
  let onSubscribe: (() => Promise<void>) | undefined
  let receiptDuringSend = false
  const sends: Record<string, unknown>[] = []
  const event = (
    field: string,
    value: Record<string, unknown>,
    wabaId = waba,
    phoneId = phone
  ) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: phoneId,
                display_phone_number: "+5511888880001",
              },
              ...value,
            },
          },
        ],
      },
    ],
  })
  const seconds = () => String(Math.floor(Date.now() / 1000))
  const inbound = (
    id: string,
    text: string,
    from = recipient,
    time = seconds()
  ) =>
    event("messages", {
      contacts: [{ wa_id: from, profile: { name: "Synthetic Customer" } }],
      messages: [
        { id, from, timestamp: time, type: "text", text: { body: text } },
      ],
    })
  async function post(payload: unknown, signature?: string) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload)
    return originalFetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256":
          signature ??
          `sha256=${createHmac("sha256", process.env.DATOOL_META_APP_SECRET!).update(body).digest("hex")}`,
      },
      body,
    })
  }
  async function accept(payload: unknown) {
    const response = await post(payload)
    assert.equal(response.status, 200, await response.text())
  }
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "graph.facebook.com") return originalFetch(input, init)
    providerCalls++
    const path = url.pathname.replace(/^\/v\d+\.0\//, "")
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (path === "oauth/access_token")
      return Response.json({ access_token: accessToken })
    if (path === "debug_token")
      return Response.json({
        data: {
          app_id: appMismatch ? "99999999999" : process.env.DATOOL_META_APP_ID,
          is_valid: true,
          scopes: [
            "whatsapp_business_management",
            "whatsapp_business_messaging",
          ],
          granular_scopes: [
            { scope: "whatsapp_business_management", target_ids: [waba] },
          ],
        },
      })
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${accessToken}`
    )
    assert(url.searchParams.has("appsecret_proof"))
    if (path === `${waba}/phone_numbers`)
      return Response.json({
        data: [
          {
            id: listedPhone,
            display_phone_number: "+5511888880001",
            verified_name: "Synthetic Store",
            is_on_biz_app: isBusinessApp,
          },
        ],
      })
    if (path === `${waba}/subscribed_apps`) {
      await onSubscribe?.()
      return Response.json({ success: true })
    }
    if (path.endsWith("/register")) {
      registerCalls++
      assert.match(body.pin, /^\d{6}$/)
      return Response.json({ success: true })
    }
    if (path.endsWith("/messages")) {
      sendCalls++
      sends.push(body)
      if (sendFailure) throw new TypeError(`Uncertain transport ${accessToken}`)
      const id = `wamid.out.${sendCalls}`
      if (receiptDuringSend)
        await accept(
          event("messages", {
            statuses: [
              {
                id,
                status: "read",
                timestamp: seconds(),
                recipient_id: recipient,
                biz_opaque_callback_data: body.biz_opaque_callback_data,
              },
            ],
          })
        )
      return Response.json({ messages: [{ id }] })
    }
    if (path === `${waba}/message_templates`) {
      if (init?.method === "DELETE") return Response.json({ success: true })
      if (init?.method === "POST")
        return Response.json({
          id: "50000000001",
          status: "PENDING",
          category: body.category,
        })
      return Response.json({
        data: [
          {
            id: "50000000001",
            name: "order_update",
            status: "APPROVED",
            language: "pt_BR",
            category: "UTILITY",
            components: [],
          },
        ],
      })
    }
    if (path.endsWith("/smb_app_data")) return Response.json({ success: true })
    if (path === phone || path === listedPhone)
      return Response.json({
        id: path,
        quality_rating: "GREEN",
        display_phone_number: "+5511888880001",
        is_on_biz_app: isBusinessApp,
      })
    throw new Error(`Unexpected Meta path ${path}`)
  }) as typeof fetch
  assert.equal(
    (
      await originalFetch(
        `${webhookUrl}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`
      )
    ).status,
    403
  )
  assert.equal(
    await (
      await originalFetch(
        `${webhookUrl}?hub.mode=subscribe&hub.verify_token=synthetic-verification-token&hub.challenge=123`
      )
    ).text(),
    "123"
  )
  assert.equal(
    (await post(inbound("invalid", "Hello"), `sha256=${"0".repeat(64)}`))
      .status,
    401
  )
  assert.equal((await post("{")).status, 400)
  assert.equal((await post(" ".repeat(4 * 1024 * 1024 + 1))).status, 413)
  assert.equal(providerCalls, 0)
  passed(
    "HTTP webhook challenge, signature, malformed JSON and body-size rejection"
  )

  const agent = await call<{ id: string; currentRevision: number }>(
    "build_create_agent",
    {
      name: "WhatsApp E2E Store",
      configuration: {
        instructions:
          "Answer refund and order questions using knowledge and order lookup.",
        model: "openai/gpt-4.1-mini",
        channelAllowlist: ["whatsapp"],
        guardrails: { blockedTopics: ["forbidden-secret-topic"] },
      },
    }
  )
  const source = await call<{ id: string }>("build_create_knowledge_source", {
    source: {
      agentId: agent.id,
      kind: "text",
      name: "Refund policy",
      text: "Refund policy: customers may request refunds within seven days of purchase. Synthetic orders have a 7 day refund window.",
    },
  })
  const indexed = await runQueuedKnowledgeJobs(context)
  assert.equal(indexed[0]?.status, "succeeded")
  assert.equal(
    (await call("build_get_knowledge_source", { sourceId: source.id })).status,
    "ready"
  )
  await call("build_save_action", {
    agentId: agent.id,
    id: "lookup_order",
    definition: {
      id: "lookup_order",
      name: "Order lookup",
      description: "Look up a synthetic order",
      type: "http",
      method: "POST",
      url: "https://postman-echo.com/post",
      channels: ["whatsapp"],
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
      responseSchema: {
        type: "object",
        properties: {
          json: {
            type: "object",
            properties: { orderId: { const: "synthetic-whatsapp-order-42" } },
            required: ["orderId"],
          },
        },
        required: ["json"],
      },
    },
  })
  await call("build_update_agent", {
    agentId: agent.id,
    expectedRevision: agent.currentRevision,
    apply: true,
  })
  const connection = await call<{ id: string }>("build_create_channel", {
    agentId: agent.id,
    channel: "whatsapp",
    label: "E2E WhatsApp",
  })
  await assert.rejects(
    call("build_update_channel_status", {
      connectionId: connection.id,
      status: "connected",
    }),
    /through Meta/
  )
  await assert.rejects(
    call("build_create_channel", {
      agentId: agent.id,
      channel: "whatsapp",
      label: "spoof",
      credentials: { token: accessToken },
    }),
    /Embedded Signup/
  )
  let signup = await call<{ id: string; state: string }>(
    "build_begin_whatsapp_signup",
    { connectionId: connection.id, mode: "coexistence" }
  )
  appMismatch = true
  await assert.rejects(
    call("build_authorize_whatsapp_signup", {
      sessionId: signup.id,
      code: "bad-app-code",
      wabaId: waba,
    }),
    /permissions for this app/
  )
  appMismatch = false
  signup = await call("build_begin_whatsapp_signup", {
    connectionId: connection.id,
    mode: "coexistence",
  })
  await assert.rejects(
    call("build_authorize_whatsapp_signup", {
      sessionId: signup.id,
      code: "wrong-waba",
      wabaId: "99999999999",
    }),
    /not granted/
  )
  signup = await call("build_begin_whatsapp_signup", {
    connectionId: connection.id,
    mode: "coexistence",
  })
  const authorized = await call("build_authorize_whatsapp_signup", {
    sessionId: signup.id,
    code: "synthetic-code",
    wabaId: waba,
  })
  assert.equal(authorized.state, "authorized")
  assert(!JSON.stringify(authorized).includes(accessToken))
  const active = await call("build_activate_whatsapp_signup", {
    sessionId: signup.id,
    phoneNumberId: phone,
  })
  assert.equal(active.status, "connected")
  assert.equal(registerCalls, 0)
  assert(!JSON.stringify(active).includes(accessToken))
  const secretRow = await database.execute<{ encrypted_credentials: string }>(
    sql`SELECT encrypted_credentials FROM build_channel_connection WHERE id=${connection.id}::uuid`
  )
  assert(!secretRow.rows[0].encrypted_credentials.includes(accessToken))
  const oldCalls = providerCalls
  await call("build_activate_whatsapp_signup", {
    sessionId: signup.id,
    phoneNumberId: phone,
  })
  assert.equal(providerCalls, oldCalls)
  await assert.rejects(
    call("build_activate_whatsapp_signup", {
      sessionId: signup.id,
      phoneNumberId: "30000000099",
    }),
    /different phone/
  )
  passed(
    "MCP authoring, indexed knowledge, server-verified coexistence signup, encrypted credentials and activation replay"
  )

  // A second project sees neither signup state nor the globally reserved phone.
  const otherProject = randomUUID()
  await database.execute(
    sql`INSERT INTO project(id,organization_id,name,slug) VALUES(${otherProject},${target.organizationId},'Other','other')`
  )
  const other = {
    ...context,
    projectId: otherProject,
    database: createTracerDatabase(undefined, { projectId: otherProject }),
  }
  await assert.rejects(
    whatsapp.getWhatsAppSignup(other, signup.id),
    /not found/
  )
  const { createAgent } = await import("../src/server/build/agents")
  const otherAgent = await createAgent(other, { name: "Other" })
  const otherConnection = await channels.createChannelConnection(other, {
    agentId: otherAgent.id,
    channel: "whatsapp",
    label: "Other",
  })
  const otherSignup = await whatsapp.beginWhatsAppSignup(other, {
    connectionId: otherConnection.id,
    mode: "coexistence",
  })
  await whatsapp.authorizeWhatsAppSignup(other, {
    sessionId: otherSignup.id,
    code: "other-code",
    wabaId: waba,
  })
  await assert.rejects(
    whatsapp.activateWhatsAppSignup(other, {
      sessionId: otherSignup.id,
      phoneNumberId: phone,
    }),
    /already connected/
  )
  await accept(
    event(
      "messages",
      {
        messages: [
          {
            id: "spoof",
            from: recipient,
            timestamp: seconds(),
            type: "text",
            text: { body: "Bad account" },
          },
        ],
      },
      "99999999999"
    )
  )
  assert.equal(
    (await database.execute(sql`SELECT id FROM build_channel_message`)).rows
      .length,
    0
  )
  passed("Cross-project signup isolation and global phone ownership")

  const usage = {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 8, text: 8, reasoning: 0 },
  }
  const model = new MockLanguageModelV4({
    modelId: "whatsapp-fixture",
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "order-lookup-1",
            toolName: "lookup_order",
            input: '{"orderId":"synthetic-whatsapp-order-42"}',
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
      {
        content: [
          {
            type: "text",
            text: "Your refund window is seven days. Order synthetic-whatsapp-order-42 was checked.",
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    ],
  })
  const runtimeResults: Array<Awaited<ReturnType<typeof runAgentTurn>>> = []
  const runner: import("../src/lib/build/channels").AgentTurnRunner = async (
    input
  ) => {
    const result = await runAgentTurn(
      context,
      {
        agentId: input.agentId,
        conversationId: input.conversationId,
        channel: input.channel,
        requestKey: String(input.metadata.requestKey),
        message: input.messages.at(-1)!.content,
      },
      {
        dependencies: {
          generateText: (options) => generateText({ ...options, model }),
        },
      }
    )
    runtimeResults.push(result)
    return {
      ownerFence: result.turn.ownerFence,
      ownerType: "ai",
      messages: result.text ? [{ text: result.text }] : [],
    }
  }
  async function job() {
    const next = await channels.claimNextChannelJob(database)
    assert(next, "Expected a durable channel job")
    return next
  }
  async function processNext() {
    const next = await job()
    const result = await channels.processChannelJob(next, runner, database)
    await channels.completeChannelJob(database, next)
    return result
  }
  const customerMessage = inbound(
    "wamid.in.1",
    "What is the refund policy for my order?"
  )
  await Promise.all([accept(customerMessage), accept(customerMessage)])
  assert.equal(
    (
      await database.execute(
        sql`SELECT id FROM build_channel_job WHERE kind='process_inbound'`
      )
    ).rows.length,
    1
  )
  await processNext()
  assert.equal(runtimeResults[0].toolCalls[0].status, "completed")
  assert(
    JSON.stringify(runtimeResults[0].toolCalls[0].output).includes(
      "synthetic-whatsapp-order-42"
    )
  )
  assert(JSON.stringify(model.doGenerateCalls[0].prompt).includes("seven days"))
  receiptDuringSend = true
  await processNext()
  receiptDuringSend = false
  assert.equal(sendCalls, 1)
  assert.equal(sends[0].to, recipient)
  assert(JSON.stringify(sends[0]).includes("seven days"))
  const sent = (
    await database.execute<{
      id: string
      conversation_id: string
      status: string
    }>(sql`SELECT * FROM build_channel_message WHERE direction='outbound'`)
  ).rows[0]
  assert.equal(sent.status, "delivered")
  await accept(
    event("messages", {
      statuses: [
        {
          id: "wamid.out.1",
          status: "sent",
          timestamp: seconds(),
          recipient_id: recipient,
        },
      ],
    })
  )
  assert.equal(
    (
      await database.execute(
        sql`SELECT status FROM build_channel_message WHERE id=${sent.id}`
      )
    ).rows[0].status,
    "delivered"
  )
  await accept(customerMessage)
  assert.equal(await channels.claimNextChannelJob(database), null)
  passed(
    "HTTP webhook → durable queue → knowledge-grounded runtime → real HTTP action → simulated Meta reply; replay and out-of-order receipts"
  )

  await accept(
    inbound("wamid.guardrail", "forbidden-secret-topic", "5511999990002")
  )
  await processNext()
  assert.equal(model.doGenerateCalls.length, 2)
  assert.equal(runtimeResults[1].status, "blocked")
  if (
    await database
      .execute(sql`SELECT 1 FROM build_channel_job WHERE status='queued'`)
      .then((r) => r.rows.length)
  )
    await processNext()
  passed(
    "Configured guardrail blocks a new WhatsApp conversation before model or action execution"
  )

  const conversations = new ConversationService(context)
  const original = await conversations.get(sent.conversation_id)
  assert(original)
  await channels.enqueueOutboundEnvelope(
    context,
    {
      connectionId: connection.id,
      conversationId: sent.conversation_id,
      channel: "whatsapp",
      idempotencyKey: "stale-ai",
      text: "This must never be sent",
    },
    `${phone}:${recipient}`,
    { expectedOwnerFence: original.ownerFence, expectedOwnerType: "ai" }
  )
  const echo = event("smb_message_echoes", {
    message_echoes: [
      {
        from: "5511888880001",
        to: recipient,
        id: "wamid.manual.1",
        timestamp: seconds(),
        type: "text",
        text: { body: "I am helping you from the Business App." },
      },
    ],
  })
  await accept(echo)
  await accept(echo)
  const beforeEchoDelivery = sendCalls
  const cancelled = await processNext()
  assert.deepEqual(cancelled, { ignored: true, reason: "human_ownership" })
  assert.equal(sendCalls, beforeEchoDelivery)
  assert.equal(
    (await conversations.get(sent.conversation_id))?.ownerType,
    "human"
  )
  const transcript = await database.execute(
    sql`SELECT * FROM build_conversation_messages WHERE project_id=${target.projectId} AND metadata_json->>'providerMessageId'='wamid.manual.1'`
  )
  assert.equal(transcript.rows.length, 1)
  const proof = await call<{ delivery: { status: string } }>(
    "build_get_whatsapp_delivery",
    { connectionId: connection.id, messageId: sent.id }
  )
  assert.equal(proof.delivery.status, "read")
  const beforeMedia = providerCalls
  await assert.rejects(
    call("build_get_whatsapp_media", {
      connectionId: connection.id,
      mediaId: "87654321000",
    }),
    /not received/
  )
  assert.equal(providerCalls, beforeMedia)
  passed(
    "Business App echo appears once in inbox and fences queued AI delivery"
  )

  await call("build_sync_whatsapp_app", {
    connectionId: connection.id,
    type: "history",
    consent: true,
  })
  await call("build_sync_whatsapp_app", {
    connectionId: connection.id,
    type: "smb_app_state_sync",
    consent: true,
  })
  const history = event("history", {
    history: [
      {
        metadata: { progress: 100 },
        threads: [
          {
            id: "5511999990003",
            messages: [
              {
                id: "wamid.history.1",
                from: "5511999990003",
                timestamp: String(Math.floor(Date.now() / 1000) - 100_000),
                type: "text",
                text: { body: "Old conversation" },
              },
            ],
          },
        ],
      },
    ],
  })
  await accept(history)
  await accept(history)
  await accept(
    event("smb_app_state_sync", {
      state_sync: [
        {
          type: "contact",
          action: "add",
          contact: {
            full_name: "Imported Customer",
            phone_number: "+5511999990003",
          },
        },
      ],
    })
  )
  assert.equal(await channels.claimNextChannelJob(database), null)
  assert.equal(
    (
      await database.execute(
        sql`SELECT id FROM build_channel_message WHERE provider_message_id='wamid.history.1'`
      )
    ).rows.length,
    1
  )
  assert.equal(
    (
      await call("build_get_whatsapp_recipient", {
        connectionId: connection.id,
        recipient: "5511999990003",
      })
    ).canReply,
    false
  )
  passed(
    "Consented history/contact import deduplicates without AI replies or reopening the service window"
  )

  await database.execute(sql`UPDATE build_contacts SET status='blocked' WHERE project_id=${target.projectId} AND id=(SELECT metadata_json->>'contactId' FROM build_conversations WHERE id=${sent.conversation_id} AND project_id=${target.projectId})`)
  await accept(inbound("wamid.blocked-contact", "Do not run the agent for this blocked contact"))
  assert.equal(await channels.claimNextChannelJob(database), null)

  // Existing installations used a connection-specific contact external ID.
  await database.execute(sql`UPDATE build_contacts SET external_id=${`whatsapp:${connection.id}:${phone}:${recipient}`} WHERE project_id=${target.projectId} AND phone=${`+${recipient}`}`)
  const secondPhone = "30000000003"
  listedPhone = secondPhone
  const secondConnection = await call<{ id: string }>("build_create_channel", { agentId: agent.id, channel: "whatsapp", label: "Second support number" })
  const secondSignup = await call<{ id: string }>("build_begin_whatsapp_signup", { connectionId: secondConnection.id, mode: "coexistence" })
  await call("build_authorize_whatsapp_signup", { sessionId: secondSignup.id, code: "second-number", wabaId: waba })
  await call("build_activate_whatsapp_signup", { sessionId: secondSignup.id, phoneNumberId: secondPhone })
  listedPhone = phone
  const otherNumberMessage = (id: string, from = recipient) => event("messages", {
    contacts: [{ wa_id: from, profile: { name: "Synthetic Customer" } }],
    messages: [{ id, from, timestamp: seconds(), type: "text", text: { body: "Same customer, another support number" } }],
  }, waba, secondPhone)
  await accept(otherNumberMessage("wamid.second-number-blocked"))
  const matchedContacts = await call<{ items: Array<{ id: string; status: string }> }>("build_list_contacts", { search: `+${recipient}` })
  assert.equal(matchedContacts.items.length, 1, "A WhatsApp sender must have one contact across business numbers")
  assert.equal(matchedContacts.items[0].status, "blocked")
  assert.equal(await channels.claimNextChannelJob(database), null, "Another business number must not bypass a blocked contact")
  const linkedIdentities = await call<Array<{ identityKey: string }>>("build_list_contact_identities", { contactId: matchedContacts.items[0].id })
  assert(linkedIdentities.some(item => item.identityKey === `${connection.id}:${phone}:${recipient}`))
  assert(linkedIdentities.some(item => item.identityKey === `${secondConnection.id}:${secondPhone}:${recipient}`))

  assert.equal((await call("build_update_channel_status", { connectionId: connection.id, status: "paused" })).status, "paused")
  await call("build_update_channel_status", { connectionId: secondConnection.id, status: "paused" })
  const concurrentSender = "5511999990008"
  await other.database.execute(sql`INSERT INTO build_contacts(id,project_id,external_id,phone,display_name) VALUES('foreign-phone-contact',${otherProject},${`whatsapp:${concurrentSender}`},${`+${concurrentSender}`},'Private customer')`)
  await Promise.all([
    accept(inbound("wamid.concurrent-first", "First number", concurrentSender)),
    accept(otherNumberMessage("wamid.concurrent-second", concurrentSender)),
  ])
  const concurrentContacts = await call<{ items: Array<{ id: string }> }>("build_list_contacts", { search: `+${concurrentSender}` })
  assert.equal(concurrentContacts.items.length, 1)
  assert.notEqual(concurrentContacts.items[0].id, "foreign-phone-contact")
  const conversationLinks = await database.execute<{ connection_id: string; contact_id: string }>(sql`SELECT metadata_json->>'connectionId' AS connection_id,metadata_json->>'contactId' AS contact_id FROM build_conversations WHERE project_id=${target.projectId} AND external_conversation_id IN (${`${phone}:${concurrentSender}`},${`${secondPhone}:${concurrentSender}`})`)
  assert.equal(conversationLinks.rows.length, 2)
  assert(conversationLinks.rows.every(row => row.contact_id === concurrentContacts.items[0].id))
  assert.deepEqual(new Set(conversationLinks.rows.map(row => row.connection_id)), new Set([connection.id,secondConnection.id]))
  assert.equal(await channels.claimNextChannelJob(database), null)
  await call("build_update_channel_status", { connectionId: connection.id, status: "connected" })
  passed("One WhatsApp contact across business numbers, concurrent admission, legacy identity reuse, project isolation and block preservation")

  await database.execute(sql`UPDATE build_contacts SET status='active' WHERE project_id=${target.projectId} AND id=(SELECT metadata_json->>'contactId' FROM build_conversations WHERE id=${sent.conversation_id} AND project_id=${target.projectId})`)
  passed("Blocked contacts enter the transcript without scheduling an agent")

  const templateDefinition = {
    connectionId: connection.id,
    name: "order_update",
    language: "pt_BR",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Your order has an update." }],
    idempotencyKey: "create-template-once",
  }
  await call("build_create_whatsapp_template", templateDefinition)
  const callsBeforeReplay = providerCalls
  await call("build_create_whatsapp_template", templateDefinition)
  assert.equal(providerCalls, callsBeforeReplay)
  await assert.rejects(
    call("build_create_whatsapp_template", {
      ...templateDefinition,
      name: "different_name",
    }),
    /different input/
  )

  assert.equal(
    (
      await call<{ items: unknown[] }>("build_list_whatsapp_templates", {
        connectionId: connection.id,
      })
    ).items.length,
    1
  )
  await database.execute(
    sql`UPDATE build_whatsapp_recipient SET last_customer_message_at=now()-interval '25 hours' WHERE connection_id=${connection.id}::uuid AND recipient_id=${recipient}`
  )
  const outbound = {
    connectionId: connection.id,
    conversationId: sent.conversation_id,
    channel: "whatsapp" as const,
    idempotencyKey: "window-test",
    text: "Late reply",
  }
  const sendsBeforePolicy = sendCalls
  await assert.rejects(
    whatsapp.sendWhatsAppEnvelope(
      context,
      outbound,
      `${phone}:${recipient}`,
      randomUUID()
    ),
    /24-hour/
  )
  await assert.rejects(
    whatsapp.sendWhatsAppEnvelope(
      context,
      {
        ...outbound,
        metadata: {
          whatsappTemplate: {
            name: "order_update",
            language: { code: "pt_BR" },
          },
        },
      },
      `${phone}:${recipient}`,
      randomUUID()
    ),
    /permission/
  )
  assert.equal(sendCalls, sendsBeforePolicy)
  await call("build_set_whatsapp_consent", {
    connectionId: connection.id,
    recipient,
    optedOut: false,
    templateOptIn: true,
    note: "Synthetic fixture consent 2026-10-19",
  })
  const templateInput = {
    connectionId: connection.id,
    conversationId: sent.conversation_id,
    template: { name: "order_update", language: { code: "pt_BR" } },
    idempotencyKey: "template-send-1",
  }
  await call("build_send_whatsapp_template", templateInput)
  await call("build_send_whatsapp_template", templateInput)
  await processNext()
  assert.equal(sends.at(-1)?.type, "template")
  assert.equal(await channels.claimNextChannelJob(database), null)
  await accept(inbound("wamid.optout", "STOP"))
  assert.equal(await channels.claimNextChannelJob(database), null)
  await assert.rejects(
    whatsapp.sendWhatsAppEnvelope(
      context,
      outbound,
      `${phone}:${recipient}`,
      randomUUID()
    ),
    /opted out/
  )
  passed(
    "MCP templates, explicit consent, 24-hour window, duplicate-send protection and STOP opt-out"
  )

  await call("build_set_whatsapp_consent", {
    connectionId: connection.id,
    recipient,
    optedOut: false,
    templateOptIn: true,
    note: "Synthetic fixture re-consent",
  })
  await call("build_send_whatsapp_template", {
    ...templateInput,
    idempotencyKey: "uncertain-send",
  })
  sendFailure = true
  const uncertainJob = await job()
  try {
    await channels.processChannelJob(uncertainJob, runner, database)
    assert.fail("Expected uncertain delivery")
  } catch (error) {
    assert.equal((error as { uncertain?: boolean }).uncertain, true)
    await channels.failChannelJob(
      database,
      uncertainJob,
      error as Error & { uncertain: boolean }
    )
  }
  sendFailure = false
  assert.equal(
    (
      await database.execute(
        sql`SELECT status FROM build_channel_job WHERE id=${uncertainJob.id}::uuid`
      )
    ).rows[0].status,
    "uncertain"
  )
  assert.equal(await channels.claimNextChannelJob(database), null)
  assert(
    !JSON.stringify(
      (await database.execute(sql`SELECT last_error FROM build_channel_job`))
        .rows
    ).includes(accessToken)
  )
  passed(
    "Ambiguous Meta send stays uncertain and is never automatically duplicated; secrets stay out of errors"
  )

  // Cancellation during provider onboarding must win even after Meta responds.
  const race = await call<{ id: string }>("build_begin_whatsapp_signup", {
    connectionId: connection.id,
    mode: "coexistence",
  })
  await call("build_authorize_whatsapp_signup", {
    sessionId: race.id,
    code: "race-code",
    wabaId: waba,
  })
  onSubscribe = async () => {
    assert.equal(
      (await post(inbound("wamid.during-activation", "Retry after activation")))
        .status,
      503
    )
    await assert.rejects(
      whatsapp.beginWhatsAppSignup(context, {
        connectionId: connection.id,
        mode: "coexistence",
      }),
      /still in progress/
    )
    await assert.rejects(
      channels.updateChannelStatus(context, connection.id, "connected"),
      /through Meta/
    )
    await whatsapp.disconnectWhatsApp(context, connection.id)
  }
  await assert.rejects(
    call("build_activate_whatsapp_signup", {
      sessionId: race.id,
      phoneNumberId: phone,
    }),
    /cancelled or expired/
  )
  onSubscribe = undefined
  assert.equal(
    (
      await call("build_get_whatsapp_connection", {
        connectionId: connection.id,
      })
    ).status,
    "disconnected"
  )
  assert.equal(
    (
      await database.execute(
        sql`SELECT encrypted_credentials FROM build_channel_connection WHERE id=${connection.id}::uuid`
      )
    ).rows[0].encrypted_credentials,
    null
  )
  passed(
    "Disconnect wins activation race and partial authorization cannot be enabled through generic status updates"
  )

  // Ordinary Cloud API onboarding registers a new number; coexistence never did.
  isBusinessApp = false
  listedPhone = "30000000002"
  const cloud = await call<{ id: string }>("build_begin_whatsapp_signup", {
    connectionId: connection.id,
    mode: "cloud",
  })
  await call("build_authorize_whatsapp_signup", {
    sessionId: cloud.id,
    code: "cloud-code",
    wabaId: waba,
  })
  await call("build_activate_whatsapp_signup", {
    sessionId: cloud.id,
    phoneNumberId: listedPhone,
    pin: "123456",
  })
  assert.equal(registerCalls, 1)
  await call("build_delete_whatsapp_template", {
    connectionId: connection.id,
    name: "order_update",
  })
  await call("build_disconnect_whatsapp", { connectionId: connection.id })
  passed("Cloud API registration and MCP disconnect/template deletion")
  console.log(
    `WhatsApp E2E: ${checkpoints.length} checkpoints passed. Meta and model were simulated; no live WhatsApp delivery claimed.`
  )
} finally {
  globalThis.fetch = originalFetch
  for (const client of clients) await client.close().catch(() => {})
  for (const mcp of servers) await mcp.close().catch(() => {})
  if (server)
    await new Promise<void>((resolve) => {
      server!.closeAllConnections()
      server!.close(() => resolve())
    })
  await pools?.db.end()
  await pools?.analyticsDb.end()
  await target.close()
}

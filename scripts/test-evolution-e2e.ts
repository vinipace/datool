/** Real PostgreSQL and HTTP ingress; simulated provider transport, no real numbers.
 * Owns Evolution tenant/lifecycle/delivery contracts absent from Meta coverage. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
const target = await createIsolatedPostgres()
let pools: typeof import("../lib/db") | undefined
let sends = 0,
  failSend = false,
  failDelete = false,
  remoteOpen = false
const instances = new Map<
  string,
  { token: string; webhook?: Record<string, unknown> }
>()
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  const url = new URL(req.url!, "http://localhost")
  const name = url.pathname.split("/").at(-1)!
  const out = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(value))
  }
  if (url.pathname === "/instance/create") {
    assert.equal(req.headers.apikey, "synthetic-global")
    instances.set(body.instanceName, { token: body.token })
    return out(201, { instance: { instanceName: body.instanceName } })
  }
  if (url.pathname === "/instance/fetchInstances") {
    const n = url.searchParams.get("instanceName")!,
      entry = instances.get(n)
    if (!entry)
      return out(req.headers.apikey === "synthetic-global" ? 404 : 401, {})
    assert(
      [entry.token, "synthetic-global"].includes(String(req.headers.apikey))
    )
    return out(200, [
      {
        name: n,
        ownerJid: remoteOpen ? "5511999990001@s.whatsapp.net" : null,
        connectionStatus: remoteOpen ? "open" : "close",
      },
    ])
  }
  const entry = instances.get(name)
  if (!entry || req.headers.apikey !== entry.token) return out(404, {})
  if (url.pathname.startsWith("/webhook/set/")) {
    entry.webhook = body.webhook
    return out(200, {})
  }
  if (url.pathname.startsWith("/instance/connect/"))
    return out(200, { base64: "data:image/png;base64,aGVsbG8=" })
  if (url.pathname.startsWith("/instance/logout/")) {
    remoteOpen = false
    return out(200, {})
  }
  if (url.pathname.startsWith("/instance/delete/")) {
    if (failDelete) return out(500, {})
    instances.delete(name)
    return out(200, {})
  }
  if (url.pathname.startsWith("/message/sendText/")) {
    sends++
    return out(
      failSend ? 500 : 201,
      failSend ? {} : { key: { id: `provider-${sends}`, fromMe: true } }
    )
  }
  out(404, {})
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_SECRET: "e".repeat(64),
    DATOOL_BUILD_ENABLED: "true",
    DATOOL_EVOLUTION_ENABLED: "true",
    DATOOL_EVOLUTION_PROJECT_IDS: target.projectId,
    DATOOL_EVOLUTION_API_KEY: "synthetic-global",
    DATOOL_EVOLUTION_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    DATOOL_PUBLIC_URL: "https://datool.example.test",
  })
  pools = await import("../lib/db")
  const { createTracerDatabase } = await import("../src/server/tracer/db")
  const { withWorkspace } = await import("../src/server/auth/context")
  const { executeBuildOperation } =
    await import("../src/server/build/bootstrap")
  const { createAgent } = await import("../src/server/build/agents")
  const channels = await import("../src/server/build/channels/service")
  const evo = await import("../src/server/build/channels/evolution")
  const { decryptChannelCredentials } =
    await import("../src/server/build/channels/secrets")
  const route =
    await import("../app/api/build-webhooks/evolution/[connectionId]/route")
  const { evolutionMessage } =
    await import("../src/server/build/channels/evolution-api")
  const database = createTracerDatabase(undefined, {
    projectId: target.projectId,
  })
  const ctx = {
    database,
    projectId: target.projectId,
    organizationId: target.organizationId,
    actorId: target.ownerId,
  }
  const agent = await createAgent(ctx, {
    name: "Evolution contract",
    configuration: {
      instructions: "Answer briefly.",
      model: "openai/gpt-4.1-mini",
      channelAllowlist: ["whatsapp"],
    },
  })
  const c = await channels.createChannelConnection(ctx, {
    agentId: agent.id,
    channel: "whatsapp",
    label: "Evolution test",
    config: { provider: "evolution" },
  })
  const identity = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    userId: target.ownerId,
    kind: "session" as const,
    scopes: ["build:read", "build:write"],
  }
  await assert.rejects(
    withWorkspace({ ...identity, scopes: ["build:read"] }, () =>
      executeBuildOperation("build_get_evolution_pairing", {
        connectionId: c.id,
      })
    ),
    /permission/i
  )
  const pair = (await withWorkspace(identity, () =>
    executeBuildOperation(
      "build_begin_evolution_connection",
      {
        connectionId: c.id,
        acceptanceVersion: "2026-10-26",
      },
      { idempotencyKey: randomUUID() }
    )
  )) as Awaited<ReturnType<typeof evo.beginEvolutionConnection>>
  assert.equal(
    (
      await database.execute(
        sql`SELECT 1 FROM build_operation_receipts WHERE operation_name='build_begin_evolution_connection'`
      )
    ).rows.length,
    0
  )
  assert(pair.qr)
  assert.equal(instances.size, 1)
  await evo.beginEvolutionConnection(ctx, {
    connectionId: c.id,
    acceptanceVersion: "2026-10-26",
  })
  assert.equal(instances.size, 1)
  assert(!JSON.stringify(pair).includes("synthetic-global"))
  await assert.rejects(
    evo.getEvolutionConnection({ ...ctx, projectId: "other-project" }, c.id),
    /not found/i
  )
  console.log("PASS pairing idempotency, safe output, project isolation")
  const row = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT encrypted_credentials FROM build_channel_connection WHERE id=${c.id}::uuid`
    )
  ).rows[0]
  const secret = decryptChannelCredentials(
    String(row.encrypted_credentials),
    target.projectId,
    c.id
  )
  const instance = [...instances.keys()][0]
  remoteOpen = true
  // A first customer message can arrive before the connection-state webhook.
  const incoming = (id: string, fromMe = false, text = "Hello") => ({
    event: "messages.upsert",
    instance,
    data: {
      key: { id, remoteJid: "5511999990002@s.whatsapp.net", fromMe },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Synthetic customer",
    },
  })
  async function webhook(payload: unknown, token = String(secret.webhook)) {
    return route.POST(
      new Request(
        `https://datool.example.test/api/build-webhooks/evolution/${c.id}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-datool-evolution-secret": token,
          },
          body: JSON.stringify(payload),
        }
      ),
      { params: Promise.resolve({ connectionId: c.id }) }
    )
  }
  assert.equal((await webhook(incoming("bad"), "wrong")).status, 401)
  assert.equal(
    (await webhook({ ...incoming("wrong-instance"), instance: "another" }))
      .status,
    400
  )
  assert.equal((await webhook(incoming("in-1"))).status, 200)
  assert.equal((await webhook(incoming("in-1"))).status, 200)
  const messages = await database.execute<Record<string, unknown>>(
    sql`SELECT * FROM build_channel_message WHERE connection_id=${c.id}::uuid`
  )
  assert.equal(messages.rows.length, 1)
  const conversationId = String(messages.rows[0].conversation_id)
  assert.equal(
    (
      await database.execute(
        sql`SELECT id FROM build_channel_job WHERE connection_id=${c.id}::uuid`
      )
    ).rows.length,
    1
  )
  const envelope = {
    connectionId: c.id,
    conversationId,
    channel: "whatsapp" as const,
    idempotencyKey: randomUUID(),
    text: "Reply",
  }
  const external = "5511999990001:5511999990002"
  await channels.enqueueOutboundEnvelope(ctx, envelope, external)
  const message = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT * FROM build_channel_message WHERE connection_id=${c.id}::uuid AND direction='outbound'`
    )
  ).rows[0]
  const ids = await evo.sendEvolutionEnvelope(
    ctx,
    envelope,
    external,
    String(message.id)
  )
  assert.equal(sends, 1)
  assert.equal(ids[0], "provider-1")
  assert.deepEqual(
    await evo.sendEvolutionEnvelope(
      ctx,
      envelope,
      external,
      String(message.id)
    ),
    ids
  )
  assert.equal(
    sends,
    1,
    "A concurrent retry that waited for the connection lock must reuse the committed receipt"
  )
  for (const status of ["READ", "SERVER_ACK", "DELIVERY_ACK"]) {
    assert.equal(
      (
        await webhook({
          event: "messages.update",
          instance,
          data: { keyId: ids[0], fromMe: true, status },
        })
      ).status,
      200
    )
  }
  const delivery = (await withWorkspace(identity, () =>
    executeBuildOperation("build_get_whatsapp_delivery", {
      connectionId: c.id,
      messageId: String(message.id),
    })
  )) as { delivery: { status: string } }
  assert.equal(delivery.delivery.status, "read")
  assert.equal((await webhook(incoming(ids[0], true, "Reply"))).status, 200)
  let conv = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT owner_type FROM build_conversations WHERE id=${conversationId}`
    )
  ).rows[0]
  assert.equal(conv.owner_type, "ai")
  assert.equal(
    (await webhook(incoming("manual-1", true, "I will help you"))).status,
    200
  )
  conv = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT owner_type FROM build_conversations WHERE id=${conversationId}`
    )
  ).rows[0]
  assert.equal(conv.owner_type, "human")
  console.log(
    "PASS authenticated ingress, deduplication, provider echo and manual handoff"
  )
  await assert.rejects(
    channels.enqueueOutboundEnvelope(
      ctx,
      {
        ...envelope,
        idempotencyKey: randomUUID(),
        metadata: { campaignId: "campaign" },
      },
      external
    ),
    /individual text replies/i
  )
  await evo.setEvolutionStatus(ctx, c.id, "paused")
  await assert.rejects(
    evo.assertEvolutionOutbound(ctx, envelope, external),
    /resume/i
  )
  assert.equal((await webhook(incoming("paused-1"))).status, 200)
  assert.equal(
    (
      await database.execute(
        sql`SELECT id FROM build_channel_job WHERE connection_id=${c.id}::uuid AND kind='process_inbound'`
      )
    ).rows.length,
    1
  )
  await evo.refreshEvolutionConnection(ctx, c.id)
  assert.equal((await evo.getEvolutionConnection(ctx, c.id)).status, "paused")
  await evo.setEvolutionStatus(ctx, c.id, "connected")
  await database.execute(
    sql`UPDATE build_whatsapp_recipient SET last_customer_message_at=now()-interval '25 hours' WHERE connection_id=${c.id}::uuid`
  )
  await assert.rejects(
    evo.assertEvolutionOutbound(ctx, envelope, external),
    /24 hours/i
  )
  await database.execute(
    sql`UPDATE build_whatsapp_recipient SET last_customer_message_at=now() WHERE connection_id=${c.id}::uuid`
  )
  await database.execute(
    sql`UPDATE build_evolution_instance SET last_send_at=NULL WHERE connection_id=${c.id}::uuid`
  )
  failSend = true
  const envelope2 = { ...envelope, idempotencyKey: randomUUID() }
  await channels.enqueueOutboundEnvelope(ctx, envelope2, external)
  const msg2 = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT id FROM build_channel_message WHERE idempotency_key=${envelope2.idempotencyKey}`
    )
  ).rows[0]
  await assert.rejects(
    evo.sendEvolutionEnvelope(ctx, envelope2, external, String(msg2.id)),
    (error: unknown) => (error as { uncertain: boolean }).uncertain === true
  )
  process.env.DATOOL_EVOLUTION_ENABLED = "false"
  await assert.rejects(
    evo.assertEvolutionOutbound(ctx, envelope, external),
    /not enabled/i
  )
  process.env.DATOOL_EVOLUTION_ENABLED = "true"
  await database.execute(
    sql`UPDATE build_conversations SET status='closed' WHERE id=${conversationId}`
  )
  await assert.rejects(
    evo.assertEvolutionOutbound(ctx, envelope, external),
    /open conversations/i
  )
  console.log(
    "PASS receptive policy, pause, stale events, closed conversation, kill switch and uncertain delivery"
  )
  const c2 = await channels.createChannelConnection(ctx, {
    agentId: agent.id,
    channel: "whatsapp",
    label: "Duplicate",
    config: { provider: "evolution" },
  })
  remoteOpen = false
  await evo.beginEvolutionConnection(ctx, {
    connectionId: c2.id,
    acceptanceVersion: "2026-10-26",
  })
  remoteOpen = true
  await assert.rejects(
    evo.refreshEvolutionConnection(ctx, c2.id),
    /already connected/i
  )
  assert.equal((await evo.getEvolutionConnection(ctx, c2.id)).phone, null)
  failDelete = true
  await assert.rejects(
    withWorkspace(identity, () =>
      executeBuildOperation(
        "build_update_channel_status",
        { connectionId: c2.id, status: "disconnected" },
        { idempotencyKey: randomUUID() }
      )
    )
  )
  assert.equal(
    (await evo.getEvolutionConnection(ctx, c2.id)).cleanupPending,
    true,
    "Generic status transport must commit local revocation even when remote cleanup fails"
  )
  failDelete = false
  await evo.reconcileEvolutionConnection(ctx, c2.id)
  assert.equal(
    evolutionMessage({
      key: { id: "lid", fromMe: false, remoteJid: "123456789012345@lid" },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: "hi" },
    }),
    null
  )
  await evo.disconnectEvolution(ctx, c.id)
  assert.equal(instances.size, 0)
  assert.equal((await webhook(incoming("late"))).status, 401)
  assert.equal(
    (await database.execute(sql`SELECT * FROM build_whatsapp_number_binding`))
      .rows.length,
    0
  )
  assert.equal(
    (
      await database.execute(
        sql`SELECT * FROM build_channel_connection WHERE id=${c.id}::uuid AND encrypted_credentials IS NOT NULL`
      )
    ).rows.length,
    0
  )
  const abandoned = await channels.createChannelConnection(ctx, {
    agentId: agent.id,
    channel: "whatsapp",
    label: "Abandoned",
    config: { provider: "evolution" },
  })
  remoteOpen = false
  await evo.beginEvolutionConnection(ctx, {
    connectionId: abandoned.id,
    acceptanceVersion: "2026-10-26",
  })
  await database.execute(
    sql`UPDATE build_evolution_instance SET started_at=now()-interval '31 minutes' WHERE connection_id=${abandoned.id}::uuid`
  )
  await evo.reconcileEvolutionConnection(ctx, abandoned.id)
  assert.equal(instances.size, 0)
  assert.equal(
    (await evo.getEvolutionConnection(ctx, abandoned.id)).state,
    "not_connected"
  )
  console.log("PASS abandoned pairing cleanup")
  console.log(
    "PASS exclusive number ownership, opaque LIDs, disconnect revocation and credential removal"
  )
} finally {
  server.closeAllConnections()
  server.close()
  await pools?.db.end()
  await pools?.analyticsDb.end()
  await target.close()
}

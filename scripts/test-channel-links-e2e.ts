/** Real PostgreSQL, outbound admission and public redirect; no external delivery. */
import assert from "node:assert/strict"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
const target = await createIsolatedPostgres()
let pools: typeof import("../lib/db") | undefined
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_SECRET: "k".repeat(64),
    DATOOL_BUILD_ENABLED: "true",
    DATOOL_PUBLIC_URL: "https://datool.example.com",
  })
  pools = await import("../lib/db")
  const { createTracerDatabase } = await import("../src/server/tracer/db")
  const { createAgent } = await import("../src/server/build/agents")
  const { ConversationService } =
    await import("../src/server/build/conversations")
  const { createChannelConnection, enqueueOutboundEnvelope } =
    await import("../src/server/build/channels/service")
  const { listChannelLinks, resolveChannelLink } =
    await import("../src/server/build/channels/links")
  const route = await import("../app/l/[token]/route")
  const database = createTracerDatabase(undefined, {
    projectId: target.projectId,
  })
  const context = {
    database,
    projectId: target.projectId,
    organizationId: target.organizationId,
    actorId: target.ownerId,
  }
  const agent = await createAgent(context, {
    name: "Link validation",
    configuration: {
      channelAllowlist: ["whatsapp"],
      model: "openai/gpt-4.1-mini",
    },
  })
  const connection = await createChannelConnection(context, {
    agentId: agent.id,
    channel: "whatsapp",
    label: "Synthetic WhatsApp",
    config: { provider: "meta" },
  })
  const conversation = await new ConversationService(context).getOrCreate({
    agentId: agent.id,
    channel: "whatsapp",
    externalConversationId: "link-test",
    metadata: { connectionId: connection.id },
  })
  const destination =
    "https://shop.example.com/cart/123:1?discount=SAVE&source=chat#checkout"
  const envelope = {
    connectionId: connection.id,
    conversationId: conversation.id,
    channel: "whatsapp" as const,
    idempotencyKey: "one-message",
    text: `Added **1 board**.\n\n[Checkout](${destination})\n\n${destination}`,
  }
  await enqueueOutboundEnvelope(context, envelope, "link-test")
  await enqueueOutboundEnvelope(context, envelope, "link-test")
  const rows = await database.execute<{
    token: string
    message_id: string
    destination: string
  }>(sql`SELECT * FROM build_channel_link`)
  assert.equal(
    rows.rows.length,
    1,
    "Retries and repeated URLs must reuse one persisted link"
  )
  const link = rows.rows[0]
  assert.equal(link.destination, destination)
  const stored = await database.execute<{ text: string }>(
    sql`SELECT content_json->>'text' AS text FROM build_channel_message WHERE id=${link.message_id}`
  )
  assert(stored.rows[0].text.includes("Added *1 board*."))
  assert(
    stored.rows[0].text.includes(`https://datool.example.com/l/${link.token}`)
  )
  assert(!stored.rows[0].text.includes(destination))
  const request = (
    method = "GET",
    ua = "Mozilla/5.0",
    extra: Record<string, string> = {}
  ) =>
    new Request(
      `https://datool.example.com/l/${link.token}?url=https://evil.example.com`,
      { method, headers: { "user-agent": ua, ...extra } }
    )
  const params = { params: Promise.resolve({ token: link.token }) }
  assert.equal(
    (await route.GET(request(), params)).status,
    404,
    "Queued messages must not expose a redirect"
  )
  await database.execute(
    sql`UPDATE build_channel_message SET status='sent' WHERE id=${link.message_id}`
  )
  const head = await route.HEAD(request("HEAD"), params)
  assert.equal(head.status, 302)
  assert.equal(head.headers.get("Location"), destination)
  assert.equal(head.headers.get("Referrer-Policy"), "no-referrer")
  assert(head.headers.get("Cache-Control")?.includes("no-store"))
  await route.GET(request("GET", "facebookexternalhit/1.1"), params)
  await route.GET(
    request("GET", "Mozilla/5.0", { purpose: "prefetch" }),
    params
  )
  await route.GET(request(), params)
  await route.GET(request(), params)
  const report = await listChannelLinks(context, connection.id)
  assert.equal(report.items[0].clicks, 2)
  assert.equal(report.items[0].automatedVisits, 2)
  assert.equal(report.items[0].conversationId, conversation.id)
  const foreign = { ...context, projectId: "another-project" }
  await assert.rejects(listChannelLinks(foreign, connection.id), /not found/i)
  assert.equal(await resolveChannelLink(foreign, link.token, request()), null)
  assert.equal(
    (
      await route.GET(request(), {
        params: Promise.resolve({ token: "x".repeat(24) }),
      })
    ).status,
    404
  )
  await enqueueOutboundEnvelope(
    context,
    {
      ...envelope,
      idempotencyKey: "unsafe",
      text: "https://127.0.0.1/private https://localhost/private https://server.internal/private",
    },
    "link-test"
  )
  assert.equal(
    (await database.execute(sql`SELECT * FROM build_channel_link`)).rows.length,
    1
  )
  await database.execute(
    sql`UPDATE build_channel_link SET expires_at=now()-interval '1 second' WHERE token=${link.token}`
  )
  assert.equal((await route.GET(request(), params)).status, 404)
  // Remove dependent delivery jobs before testing the message-link cascade.
  await database.execute(
    sql`DELETE FROM build_channel_job WHERE connection_id=${connection.id}::uuid`
  )
  await database.execute(
    sql`DELETE FROM build_conversations WHERE id=${conversation.id}`
  )
  assert.equal(
    (await database.execute(sql`SELECT * FROM build_channel_link`)).rows.length,
    0
  )
  console.log(
    "PASS atomic link admission, retries, WhatsApp formatting, redirect target integrity, HEAD/preview separation, click counters, project isolation, expiry and deletion"
  )
} finally {
  if (pools) {
    await pools.db.end()
    if (pools.analyticsDb !== pools.db) await pools.analyticsDb.end()
  }
  await target.close()
}

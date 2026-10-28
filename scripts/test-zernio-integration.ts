/** Provider responses are simulated; all state and webhook routing use isolated PostgreSQL. */
import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import sharp from "sharp"
import { sql } from "drizzle-orm"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"

const target = await createIsolatedPostgres()
const originalFetch = globalThis.fetch
let pools: typeof import("../lib/db") | undefined
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    DATOOL_BUILD_ENABLED: "true",
    DATOOL_PUBLIC_URL: "https://datool.example.test",
    DATOOL_ZERNIO_API_KEY: "test-api-key",
    DATOOL_ZERNIO_WEBHOOK_SECRET: "test-webhook-secret",
    BETTER_AUTH_SECRET: "a".repeat(64),
  })
  pools = await import("../lib/db")
  const { createTracerDatabase } = await import("../src/server/tracer/db")
  const { createAgent } = await import("../src/server/build/agents")
  const channels = await import("../src/server/build/channels/service")
  const zernio = await import("../src/server/build/channels/zernio")
  const route = await import("../app/api/build-webhooks/zernio/route")
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
    name: "Test agent",
    configuration: {
      instructions: "Answer briefly.",
      model: "openai/gpt-4.1-mini",
      channelAllowlist: ["whatsapp"],
    },
  })
  const channel = await channels.createChannelConnection(context, {
    agentId: agent.id,
    channel: "whatsapp",
    label: "WhatsApp",
    config: { provider: "zernio" },
  })
  const imageBytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  const wav = Buffer.alloc(44 + 32000)
  wav.write("RIFF")
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(32000, 40)
  let transcriptions = 0
  let profile: Record<string, unknown> | undefined
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request))
    if (url.origin === "https://ai-gateway.vercel.sh") {
      transcriptions++
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer project-gateway-key"
      )
      return Response.json(
        { text: "transcribed audio", durationInSeconds: 1 },
        { headers: { "x-request-id": "test-transcription" } }
      )
    }
    assert.equal(url.origin, "https://zernio.com")
    const method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: `${method} ${url.pathname}`, body })
    if (url.pathname === "/api/v1/profiles" && method === "GET")
      return Response.json({ profiles: profile ? [profile] : [] })
    if (url.pathname === "/api/v1/profiles" && method === "POST") {
      profile = { _id: "profile1", ...body }
      return Response.json({ profile }, { status: 201 })
    }
    if (url.pathname === "/api/v1/connect/whatsapp")
      return Response.json({ authUrl: "https://www.facebook.com/signup" })
    if (url.pathname === "/api/v1/accounts" && method === "GET")
      return Response.json({
        accounts: [
          {
            _id: "account1",
            platform: "whatsapp",
            profileId: { _id: "profile1" },
            isActive: true,
            username: "+5511999995330",
          },
        ],
      })
    if (url.pathname.endsWith("/messages"))
      return Response.json({
        success: true,
        data: {
          messageId: body?.template
            ? "wamid.template"
            : body?.message === "image response"
              ? "wamid.worker"
              : "wamid.outbound",
        },
      })
    if (url.pathname === "/api/v1/whatsapp/media/media1")
      return new Response(new Uint8Array(imageBytes), {
        headers: { "content-type": "image/jpeg" },
      })
    if (url.pathname === "/api/v1/whatsapp/media/media2")
      return new Response(new Uint8Array(wav), {
        headers: { "content-type": "audio/wav" },
      })
    if (url.pathname === "/api/v1/accounts/account1" && method === "DELETE")
      return Response.json({ message: "Disconnected" })
    throw new Error(`Unexpected provider call: ${method} ${url.pathname}`)
  }
  const start = await zernio.beginZernioSignup(context, {
    connectionId: channel.id,
    mode: "coexistence",
  })
  assert.equal(start.authUrl, "https://www.facebook.com/signup")
  const state = (
    await database.execute<{ signup_id: string }>(
      sql`SELECT signup_id FROM build_zernio_whatsapp WHERE connection_id=${channel.id}::uuid`
    )
  ).rows[0].signup_id
  await assert.rejects(
    () =>
      zernio.finishZernioSignup(context, {
        connectionId: channel.id,
        signupId: state,
        accountId: "another-account",
      }),
    /did not confirm/
  )
  await zernio.finishZernioSignup(context, {
    connectionId: channel.id,
    signupId: state,
    accountId: "account1",
  })
  assert.equal(
    (await zernio.getZernioConnection(context, channel.id)).status,
    "connected"
  )
  console.log(
    "PASS signup verifies the remote account belongs to this channel profile"
  )
  const timestamp = new Date().toISOString()
  const event = {
    id: randomUUID(),
    event: "message.received",
    timestamp,
    account: {
      accountId: "account1",
      profileId: "profile1",
      platform: "whatsapp",
    },
    conversation: { id: "thread1", participantId: "5511999995050" },
    message: {
      platform: "whatsapp",
      direction: "incoming",
      platformMessageId: "wamid.inbound",
      conversationId: "thread1",
      text: "hello",
      sentAt: timestamp,
      sender: { phoneNumber: "5511999995050", name: "Customer" },
      attachments: [
        { type: "image", payload: { id: "media1" }, mimeType: "image/jpeg" },
      ],
    },
  }
  async function webhook(payload: unknown, valid = true) {
    const body = JSON.stringify(payload)
    const signature = createHmac(
      "sha256",
      valid ? "test-webhook-secret" : "wrong"
    )
      .update(body)
      .digest("hex")
    return route.POST(
      new Request("https://datool.example.test/api/build-webhooks/zernio", {
        method: "POST",
        headers: { "x-zernio-signature": signature },
        body,
      })
    )
  }
  assert.equal((await webhook(event, false)).status, 401)
  assert.equal(
    (
      await webhook({
        ...event,
        account: { ...event.account, profileId: "other-profile" },
      })
    ).status,
    200
  )
  assert.equal(
    (await database.execute(sql`SELECT id FROM build_channel_message`)).rows
      .length,
    0
  )
  assert.equal((await webhook(event)).status, 200)
  assert.equal((await webhook(event)).status, 200)
  const messages = await database.execute<{
    id: string
    conversation_id: string
    content_json: { attachments: Array<{ fileId: string }> }
  }>(
    sql`SELECT id,conversation_id,content_json FROM build_channel_message WHERE direction='inbound'`
  )
  assert.equal(messages.rows.length, 1)
  assert.equal(messages.rows[0].content_json.attachments[0].fileId, "media1")
  assert.deepEqual(
    (await zernio.downloadZernioMedia(context, messages.rows[0].id)).bytes,
    imageBytes
  )
  console.log(
    "PASS signed inbound messages are deduplicated, tenant scoped and media is fetched through Zernio"
  )
  const { prepareEvolutionMedia } =
    await import("../src/server/build/channels/media")
  const preparedImage = await prepareEvolutionMedia(
    context,
    messages.rows[0].id,
    async () => {},
    "zernio"
  )
  assert.equal(preparedImage.images[0].mediaType, "image/jpeg")
  const inboundJob = await channels.claimNextChannelJob(database)
  assert(inboundJob && inboundJob.kind === "process_inbound")
  let agentCalls = 0
  await channels.processChannelJob(
    inboundJob,
    async (input) => {
      agentCalls++
      assert.equal(input.images?.[0].mediaType, "image/jpeg")
      return { messages: [{ text: "image response" }] }
    },
    database
  )
  await channels.completeChannelJob(database, inboundJob)
  assert.equal(agentCalls, 1)
  const deliveryJob = await channels.claimNextChannelJob(database)
  assert(deliveryJob && deliveryJob.kind === "deliver_outbound")
  await channels.processChannelJob(
    deliveryJob,
    async () => {
      throw new Error("Delivery must not call the agent")
    },
    database
  )
  await channels.completeChannelJob(database, deliveryJob)
  assert.equal(
    (
      await database.execute<{ status: string }>(
        sql`SELECT status FROM build_channel_message WHERE provider_message_id='wamid.worker'`
      )
    ).rows[0].status,
    "sent"
  )
  console.log(
    "PASS inbound image runs the agent and delivers its reply through the worker"
  )
  const { saveProjectProviderKey } =
    await import("../src/server/model-providers/store")
  await saveProjectProviderKey(
    target.projectId,
    "vercel-ai-gateway",
    "project-gateway-key"
  )
  const audioEvent = {
    ...event,
    id: randomUUID(),
    message: {
      ...event.message,
      platformMessageId: "wamid.audio",
      text: "",
      attachments: [{ type: "audio", payload: { id: "media2" } }],
    },
  }
  assert.equal((await webhook(audioEvent)).status, 200)
  const audioMessage = (
    await database.execute<{ id: string }>(
      sql`SELECT id FROM build_channel_message WHERE provider_message_id='wamid.audio'`
    )
  ).rows[0]
  assert.equal(
    (
      await prepareEvolutionMedia(
        context,
        audioMessage.id,
        async () => {},
        "zernio"
      )
    ).text,
    "transcribed audio"
  )
  assert.equal(
    (
      await prepareEvolutionMedia(
        context,
        audioMessage.id,
        async () => {},
        "zernio"
      )
    ).text,
    "transcribed audio"
  )
  assert.equal(transcriptions, 1)
  const audioUsage = await database.execute<{
    credit_operation_id: string | null
  }>(
    sql`SELECT credit_operation_id FROM build_usage_event WHERE event_key=${`transcription:${audioMessage.id}`}`
  )
  assert.equal(audioUsage.rows[0].credit_operation_id, null)
  console.log(
    "PASS image decoding and audio transcription use the project Gateway key without duplicate charge"
  )

  const outboundId = randomUUID()
  await database.execute(
    sql`INSERT INTO build_channel_message (id,project_id,connection_id,conversation_id,direction,idempotency_key,content_json,status) VALUES(${outboundId},${context.projectId},${channel.id}::uuid,${messages.rows[0].conversation_id},'outbound','reply1','{}'::jsonb,'sending')`
  )
  const ids = await zernio.sendZernioEnvelope(
    context,
    {
      connectionId: channel.id,
      conversationId: messages.rows[0].conversation_id,
      channel: "whatsapp",
      idempotencyKey: "reply1",
      text: "Hello!",
    },
    "account1:thread1",
    outboundId
  )
  assert.deepEqual(ids, ["wamid.outbound"])
  assert(
    calls.some(
      (c) => c.path.endsWith("/messages") && c.body?.message === "Hello!"
    )
  )
  const receipt = {
    ...event,
    id: randomUUID(),
    event: "message.delivered",
    statusAt: timestamp,
    message: {
      ...event.message,
      direction: "outgoing",
      platformMessageId: "wamid.outbound",
    },
  }
  assert.equal((await webhook(receipt)).status, 200)
  assert.equal(
    (
      await database.execute<{ status: string }>(
        sql`SELECT status FROM build_channel_message WHERE id=${outboundId}`
      )
    ).rows[0].status,
    "delivered"
  )
  console.log(
    "PASS reply uses the correct conversation and a provider delivery receipt updates the ledger"
  )
  await database.execute(
    sql`UPDATE build_whatsapp_recipient SET last_customer_message_at=now()-interval '25 hours' WHERE connection_id=${channel.id}::uuid`
  )
  const templateMessage = randomUUID()
  await database.execute(
    sql`INSERT INTO build_channel_message (id,project_id,connection_id,conversation_id,direction,idempotency_key,content_json,status) VALUES(${templateMessage},${context.projectId},${channel.id}::uuid,${messages.rows[0].conversation_id},'outbound','template1','{}'::jsonb,'sending')`
  )
  const templateEnvelope = {
    connectionId: channel.id,
    conversationId: messages.rows[0].conversation_id,
    channel: "whatsapp" as const,
    idempotencyKey: "template1",
    text: "",
    metadata: {
      whatsappTemplate: { name: "order_update", language: { code: "pt_BR" } },
    },
  }
  await assert.rejects(
    () =>
      zernio.sendZernioEnvelope(
        context,
        templateEnvelope,
        "account1:thread1",
        templateMessage
      ),
    /permission/
  )
  const whatsapp = await import("../src/server/build/channels/whatsapp")
  await whatsapp.setWhatsAppConsent(context, {
    connectionId: channel.id,
    recipient: "5511999995050",
    optedOut: false,
    templateOptIn: true,
    note: "Synthetic test consent",
  })
  await zernio.sendZernioEnvelope(
    context,
    templateEnvelope,
    "account1:thread1",
    templateMessage
  )
  const sentTemplate = calls.find((call) => call.body?.template)?.body
    ?.template as { elements: Array<{ language: string }> }
  assert.equal(sentTemplate.elements[0].language, "pt_BR")
  console.log(
    "PASS approved template sends require opt-in and use Zernio's language format"
  )
  const disconnectEvent = {
    ...event,
    id: randomUUID(),
    event: "account.disconnected",
  }
  assert.equal((await webhook(disconnectEvent)).status, 200)
  assert.equal(
    (await zernio.getZernioConnection(context, channel.id)).status,
    "error"
  )
  await zernio.beginZernioSignup(context, {
    connectionId: channel.id,
    mode: "coexistence",
  })
  const reconnectState = (
    await database.execute<{ signup_id: string }>(
      sql`SELECT signup_id FROM build_zernio_whatsapp WHERE connection_id=${channel.id}::uuid`
    )
  ).rows[0].signup_id
  await zernio.finishZernioSignup(context, {
    connectionId: channel.id,
    signupId: reconnectState,
    accountId: "account1",
  })
  assert.equal(
    (await zernio.getZernioConnection(context, channel.id)).status,
    "connected"
  )
  console.log(
    "PASS provider disconnection is visible and the same account can reconnect"
  )
  await zernio.disconnectZernio(context, channel.id)
  assert.equal(
    (await zernio.getZernioConnection(context, channel.id)).status,
    "disconnected"
  )
  assert(calls.some((c) => c.path === "DELETE /api/v1/accounts/account1"))
  console.log("PASS disconnect stops the provider account and local routing")
} finally {
  globalThis.fetch = originalFetch
  if (pools) {
    await pools.db.end()
    await pools.analyticsDb.end()
  }
  await target.close()
}

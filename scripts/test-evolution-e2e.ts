/** Real PostgreSQL and HTTP ingress; simulated provider transport, no real numbers.
 * Owns Evolution tenant/lifecycle/delivery contracts absent from Meta coverage. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import sharp from "sharp"
import { execFileSync } from "node:child_process"
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
const sentNumbers: string[] = []
const storedMessages = new Map<string, Record<string, unknown>>()
let lookupFailure = ""
let mediaBase64 = "",
  mediaMime = "image/png"
let transcriptions = 0,
  transcriptionMode = "ok"
const realFetch = globalThis.fetch
// Exercise the production multipart transport and credit ledger without a paid call.
globalThis.fetch = (async (input, init) => {
  if (String(input) !== "https://api.openai.com/v1/audio/transcriptions")
    return realFetch(input, init)
  transcriptions++
  assert.equal(
    new Headers(init?.headers).get("authorization"),
    "Bearer synthetic-transcription"
  )
  const form = init?.body as FormData
  assert.equal(form.get("model"), "gpt-transcribe")
  const file = form.get("file") as Blob
  const bytes = Buffer.from(await file.arrayBuffer())
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF")
  if (transcriptionMode === "timeout")
    throw new Error("synthetic lost response")
  if (transcriptionMode === "rejected")
    return Response.json({}, { status: 429 })
  return Response.json(
    {
      text: "Quero ver três produtos",
      usage: { type: "duration", seconds: 1 },
    },
    { headers: { "x-request-id": "transcription-test" } }
  )
}) as typeof fetch
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
  if (url.pathname.startsWith("/chat/findMessages/")) {
    if (lookupFailure === "unavailable") return out(503, {})
    const stored = structuredClone(storedMessages.get(body.where?.key?.id))
    if (!stored || lookupFailure === "missing")
      return out(200, { messages: { total: 0, records: [] } })
    const key = stored.key as Record<string, unknown>
    if (lookupFailure === "wrong-id") key.id = "another-message"
    if (lookupFailure === "wrong-phone")
      key.remoteJidAlt = "5511999990009@s.whatsapp.net"
    if (lookupFailure === "from-me") key.fromMe = true
    if (lookupFailure === "no-lid") key.remoteJid = key.remoteJidAlt
    if (lookupFailure === "wrong-time") stored.messageTimestamp = 1
    const records = lookupFailure === "duplicates" ? [stored, stored] : [stored]
    return out(200, { messages: { total: records.length, records } })
  }
  if (url.pathname.startsWith("/chat/getBase64FromMediaMessage/")) {
    assert(storedMessages.has(body.message.key.id))
    assert.equal(body.convertToMp4, false)
    return out(200, { base64: mediaBase64, mimetype: mediaMime })
  }
  if (url.pathname.startsWith("/message/sendText/")) {
    sends++
    sentNumbers.push(body.number)
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
  const lidIncoming = incoming("in-1")
  const lidPayload = {
    ...lidIncoming,
    data: {
      ...lidIncoming.data,
      key: {
        ...lidIncoming.data.key,
        remoteJid: "123456789012345@lid",
        remoteJidAlt: lidIncoming.data.key.remoteJid,
        addressingMode: "lid",
      },
    },
  }
  storedMessages.set("in-1", lidPayload.data)
  // Evolution 2.3.7 persists the original key, then replaces remoteJid with
  // remoteJidAlt before MESSAGES_UPSERT. Exercise that actual wire contract.
  const normalizedPayload = {
    ...lidPayload,
    data: {
      ...lidPayload.data,
      key: {
        ...lidPayload.data.key,
        remoteJid: lidIncoming.data.key.remoteJid,
      },
    },
  }
  assert.equal((await webhook(normalizedPayload)).status, 200)
  assert.equal((await webhook(normalizedPayload)).status, 200)
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
    metadata: { evolution: { replyJid: "999999999999999@lid" } },
  }
  const external = "5511999990001:5511999990002"
  await channels.enqueueOutboundEnvelope(ctx, envelope, external)
  const message = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT * FROM build_channel_message WHERE connection_id=${c.id}::uuid AND direction='outbound'`
    )
  ).rows[0]
  for (const failure of [
    "missing",
    "wrong-id",
    "wrong-phone",
    "from-me",
    "no-lid",
    "wrong-time",
    "duplicates",
    "unavailable",
  ]) {
    lookupFailure = failure
    await assert.rejects(
      evo.sendEvolutionEnvelope(ctx, envelope, external, String(message.id)),
      (error: unknown) =>
        error instanceof Error &&
        "uncertain" in error &&
        error.uncertain === false,
      `Address lookup ${failure} must fail before attempting a send`
    )
    assert.equal(
      sends,
      0,
      "Never fall back to a phone when a LID address cannot be verified"
    )
  }
  lookupFailure = ""
  const ids = await evo.sendEvolutionEnvelope(
    ctx,
    envelope,
    external,
    String(message.id)
  )
  assert.equal(sends, 1)
  assert.equal(ids[0], "provider-1")
  assert.equal(
    sentNumbers[0],
    "123456789012345@lid",
    "Reply to the authenticated incoming LID without changing the phone-based conversation identity"
  )
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
  for (const status of ["ERROR", "SERVER_ACK"]) {
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
  const rejectedDelivery = (await withWorkspace(identity, () =>
    executeBuildOperation("build_get_whatsapp_delivery", {
      connectionId: c.id,
      messageId: String(message.id),
    })
  )) as { status: string; delivery: { status: string }; errorCode: string }
  assert.equal(
    rejectedDelivery.status,
    "failed",
    "A provider error must not remain sent or be revived by a delayed server ACK"
  )
  assert.equal(rejectedDelivery.delivery.status, "failed")
  assert.equal(rejectedDelivery.errorCode, "WHATSAPP_DELIVERY_FAILED")
  await assert.rejects(
    evo.sendEvolutionEnvelope(ctx, envelope, external, String(message.id)),
    /rejected/i
  )
  assert.equal(
    sends,
    1,
    "A provider rejection must not automatically resend the same message"
  )
  for (const status of ["READ", "SERVER_ACK", "DELIVERY_ACK", "ERROR"]) {
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
  )) as {
    status: string
    delivery: { status: string }
    errorCode: string | null
  }
  assert.equal(delivery.delivery.status, "read")
  assert.equal(delivery.status, "delivered")
  assert.equal(delivery.errorCode, null)
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
  const otherIncoming = incoming("other-customer")
  otherIncoming.data.key.remoteJid = "5511999990003@s.whatsapp.net"
  assert.equal((await webhook(otherIncoming)).status, 200)
  const otherConversation = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT id FROM build_conversations WHERE project_id=${target.projectId} AND external_conversation_id='5511999990001:5511999990003'`
    )
  ).rows[0]
  const otherEnvelope = {
    ...envelope,
    conversationId: String(otherConversation.id),
    idempotencyKey: randomUUID(),
  }
  await channels.enqueueOutboundEnvelope(
    ctx,
    otherEnvelope,
    "5511999990001:5511999990003"
  )
  const otherMessage = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT id FROM build_channel_message WHERE idempotency_key=${otherEnvelope.idempotencyKey}`
    )
  ).rows[0]
  await database.execute(
    sql`UPDATE build_evolution_instance SET last_send_at=NULL WHERE connection_id=${c.id}::uuid`
  )
  await evo.sendEvolutionEnvelope(
    ctx,
    otherEnvelope,
    "5511999990001:5511999990003",
    String(otherMessage.id)
  )
  assert.equal(
    sentNumbers.at(-1),
    "5511999990003",
    "Never borrow another conversation's LID or route from outbound caller metadata"
  )
  console.log(
    "PASS trusted LID replies, phone fallback, address isolation and terminal error receipts"
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
    2
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
  failSend = false
  Object.assign(process.env, {
    DATOOL_BILLING_ENABLED: "true",
    DATOOL_MANAGED_EXECUTION_ENABLED: "true",
    DATOOL_TRANSCRIPTION_OPENAI_API_KEY: "synthetic-transcription",
  })
  const { executionCredits } =
    await import("../src/server/execution-credits/ledger")
  const { prepareEvolutionMedia } =
    await import("../src/server/build/channels/media")
  await database.execute(
    sql`INSERT INTO organization_billing(organization_id,subscription_id,price_id,status,access_until,checkout_attempt_id) VALUES(${target.organizationId},'sub','price_core','active',now()+interval '30 days','attempt')`
  )
  await executionCredits.grant({
    organizationId: target.organizationId,
    subscriptionId: "sub",
    invoiceId: "invoice",
    start: new Date(Date.now() - 1000),
    end: new Date(Date.now() + 86400000),
    plan: "core",
  })
  // Drain unrelated jobs without executing additional synthetic turns.
  await database.execute(
    sql`UPDATE build_channel_job SET status='succeeded',lock_token=NULL,locked_at=NULL WHERE project_id=${target.projectId}`
  )
  async function admitMedia(id: string, type: "image" | "audio", caption = true) {
    const base = incoming(id)
    base.data.key.remoteJid = "5511999990007@s.whatsapp.net"
    const payload = {
      ...base,
      data: {
        ...base.data,
        message: {
          [type + "Message"]: {
            mimetype: mediaMime,
            caption:
              type === "image" && caption ? "O que aparece aqui?" : undefined,
            url: "http://127.0.0.1/never-fetch",
            mediaKey: "do-not-persist",
          },
        },
      },
    }
    storedMessages.set(id, payload.data)
    assert.equal((await webhook(payload)).status, 200)
    assert.equal((await webhook(payload)).status, 200)
    const message = (
      await database.execute<Record<string, unknown>>(
        sql`SELECT * FROM build_channel_message WHERE project_id=${target.projectId} AND provider_message_id=${id}`
      )
    ).rows[0]
    assert.equal(
      message.status,
      "accepted",
      "Media must be admitted to an AI turn, not silently ignored"
    )
    assert(!JSON.stringify(message.content_json).includes("do-not-persist"))
    const job = await channels.claimNextChannelJob(database)
    assert(job && job.kind === "process_inbound")
    assert.equal(job.messageId, message.id)
    return { message, job }
  }
  async function runMedia(
    job: NonNullable<Awaited<ReturnType<typeof channels.claimNextChannelJob>>>,
    check: (input: import("../src/lib/build/channels").AgentTurnInput) => void
  ) {
    let calls = 0
    await channels.processChannelJob(
      job,
      async (input) => {
        calls++
        check(input)
        return { messages: [{ text: "Entendi sua mensagem." }] }
      },
      database
    )
    await channels.completeChannelJob(database, job)
    await database.execute(
      sql`UPDATE build_channel_job SET status='succeeded' WHERE project_id=${target.projectId} AND kind='deliver_outbound'`
    )
    return calls
  }
  mediaBase64 = (
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
  ).toString("base64")
  const imageJob = await admitMedia("image-1", "image")
  assert.equal(
    await runMedia(imageJob.job, (input) => {
      assert.equal(input.messages.at(-1)?.content, "O que aparece aqui?")
      assert.equal(input.images?.length, 1)
      assert.equal(input.images?.[0].mediaType, "image/jpeg")
      assert(input.images![0].data.length > 0)
    }),
    1
  )
  const bareImage = await admitMedia("image-no-caption", "image", false)
  assert.equal(
    await runMedia(bareImage.job, (input) => {
      assert.equal(input.messages.at(-1)?.content, "[Image]")
      assert.equal(input.images?.length, 1)
    }),
    1
  )
  await assert.rejects(
    prepareEvolutionMedia(
      { ...ctx, projectId: "other-project" },
      String(imageJob.message.id),
      async () => {}
    )
  )
  // A one-second PCM fixture exercises real local decoding and multipart upload.
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
  mediaMime = "audio/ogg; codecs=opus"
  mediaBase64 = execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-f",
      "ogg",
      "pipe:1",
    ],
    { input: wav, maxBuffer: 100_000 }
  ).toString("base64")
  const audioJob = await admitMedia("audio-1", "audio")
  assert.equal(
    await runMedia(audioJob.job, (input) => {
      assert.equal(input.messages.at(-1)?.content, "Quero ver três produtos")
      assert.equal(input.images?.length, 0)
    }),
    1
  )
  assert.equal(transcriptions, 1)
  assert.equal(
    (
      await prepareEvolutionMedia(
        ctx,
        String(audioJob.message.id),
        async () => {}
      )
    ).text,
    "Quero ver três produtos"
  )
  assert.equal(
    transcriptions,
    1,
    "A retry reuses the transcript and never dispatches another paid request"
  )
  const usage = await executionCredits.usage(target.organizationId)
  assert.equal(usage.used, 0.000075)
  assert.equal(usage.reserved, 0)
  const attributed = (
    await database.execute<Record<string, unknown>>(
      sql`SELECT * FROM build_usage_event WHERE project_id=${target.projectId} AND model='gpt-transcribe'`
    )
  ).rows
  assert.equal(attributed.length, 1)
  assert.equal(attributed[0].conversation_id, audioJob.message.conversation_id)
  assert.equal(Number(attributed[0].cost_nano_usd), 75000)
  const cancelled = await admitMedia("audio-cancelled", "audio")
  let admissionChecks = 0
  await assert.rejects(
    prepareEvolutionMedia(ctx, String(cancelled.message.id), async () => {
      admissionChecks++
      if (admissionChecks === 3) throw new Error("Ownership changed")
    })
  )
  assert.equal(admissionChecks, 3)
  assert.equal(transcriptions, 1)
  assert.equal(
    (await executionCredits.usage(target.organizationId)).reserved,
    0
  )
  assert.equal(
    await runMedia(cancelled.job, () =>
      assert.fail("Cancelled audio must not invoke AI")
    ),
    0
  )
  transcriptionMode = "rejected"
  const rejectedAudio = await admitMedia("audio-rejected", "audio")
  assert.equal(
    await runMedia(rejectedAudio.job, () =>
      assert.fail("Rejected audio must not invoke AI")
    ),
    0
  )
  assert.equal(
    (await executionCredits.usage(target.organizationId)).reserved,
    0
  )
  assert.equal(
    (await executionCredits.usage(target.organizationId)).used,
    0.000075
  )
  transcriptionMode = "timeout"
  const uncertainAudio = await admitMedia("audio-uncertain", "audio")
  assert.equal(
    await runMedia(uncertainAudio.job, () =>
      assert.fail("Uncertain audio must not invoke AI")
    ),
    0
  )
  const attempts = transcriptions
  await assert.rejects(
    prepareEvolutionMedia(
      ctx,
      String(uncertainAudio.message.id),
      async () => {}
    )
  )
  assert.equal(transcriptions, attempts)
  assert.equal(
    (await executionCredits.usage(target.organizationId)).reserved,
    0.0225
  )
  await database.execute(
    sql`UPDATE execution_credit_period SET allowance=spent+reserved WHERE organization_id=${target.organizationId}`
  )
  const unfunded = await admitMedia("audio-no-credits", "audio")
  assert.equal(
    await runMedia(unfunded.job, () =>
      assert.fail("Unfunded audio must not invoke AI")
    ),
    0
  )
  assert.equal(
    transcriptions,
    attempts,
    "No paid request when credits are exhausted"
  )
  assert(
    (
      await database.execute(
        sql`SELECT 1 FROM build_channel_message WHERE project_id=${target.projectId} AND direction='outbound' AND content_json->>'text' LIKE '%envie sua mensagem por texto%'`
      )
    ).rows.length >= 3
  )
  // Wrong-conversation provider records and malformed images never reach AI.
  lookupFailure = "wrong-phone"
  mediaMime = "image/png"
  const wrongMedia = await admitMedia("image-wrong-owner", "image")
  assert.equal(
    await runMedia(wrongMedia.job, () =>
      assert.fail("Mismatched media must not invoke AI")
    ),
    0
  )
  lookupFailure = ""
  mediaBase64 = Buffer.from("not an image").toString("base64")
  const malformed = await admitMedia("image-malformed", "image")
  assert.equal(
    await runMedia(malformed.job, () =>
      assert.fail("Invalid image must not invoke AI")
    ),
    0
  )
  assert.equal(transcriptions, attempts)
  console.log(
    "PASS image bytes and caption, audio transcript, measured credits, retry reuse, rejected/uncertain/unfunded outcomes and customer feedback"
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
  for (const remoteJid of [
    "status@broadcast",
    "123456789@g.us",
    "123456789@newsletter",
  ]) {
    assert.equal(
      evolutionMessage({
        key: {
          id: "non-direct",
          fromMe: false,
          remoteJid,
          remoteJidAlt: "5511999990002@s.whatsapp.net",
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "Not a direct message" },
      }),
      null
    )
  }
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
  globalThis.fetch = realFetch
  server.closeAllConnections()
  server.close()
  await pools?.db.end()
  await pools?.analyticsDb.end()
  await target.close()
}

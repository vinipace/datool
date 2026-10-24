import { configureBuildTestEnvironment } from "./helpers/build-env"
import { expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import { createConversationService } from "@/src/server/build/conversations"
import { assignTicket, getTicket, takeoverConversation } from "@/src/server/build/operations/inbox"
import { registerInboxDevice } from "@/src/server/build/mobile/devices"
import { drainInboxPush } from "@/src/server/build/mobile/push"
import { getTracerProjectId } from "@/src/server/tracer/db"
import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { spawn } from "node:child_process"
import { createIsolatedPostgres, migrateIsolatedPostgres } from "./helpers/postgres"

configureBuildTestEnvironment()

async function fixture() {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const members = await database.execute<{ user_id: string; organization_id: string }>(sql`
    select m."userId" as user_id,p.organization_id from member m
    join project p on p.organization_id=m."organizationId" where p.id=${projectId}`)
  const { user_id: userId, organization_id: organizationId } = members.rows[0]!
  const context = { database, projectId, actorId: userId, organizationId }
  await createAgent(context, { id: "support", name: "Support", slug: "support", configuration: { model: "openai/gpt-4.1-mini" } })
  const subscribe = async (user = userId) => {
    const sessionId = crypto.randomUUID()
    await database.execute(sql`insert into session(id,"userId",token,"expiresAt")
      values (${sessionId},${user},${crypto.randomUUID()},now()+interval '1 day')`)
    const input = { installationId: crypto.randomUUID(), token: `ExpoPushToken[${crypto.randomUUID()}]` }
    await registerInboxDevice(database, { projectId, userId: user, sessionId }, input)
    return { ...input, sessionId }
  }
  const handoff = async () => {
    const service = createConversationService(context)
    const conversation = await service.getOrCreate({ agentId: "support", channel: "web", metadata: {} })
    await service.appendMessage(conversation.id, { role: "user", content: "Private customer details", status: "completed", metadata: {} })
    await service.claim(conversation.id, { type: "human", id: "team:support", reason: "Agent handoff action" })
    const tickets = await database.execute<{ id: string }>(sql`select id from build_inbox_tickets where conversation_id=${conversation.id}`)
    return { conversation, ticket: await getTicket(context, tickets.rows[0]!.id) }
  }
  return { database, context, userId, organizationId, projectId, subscribe, handoff }
}

test("handoffs survive enqueue, concurrent workers deduplicate, receipts record acceptance, and teams can be claimed", async () => {
  const f = await fixture()
  const sent: Record<string, unknown>[] = []
  const provider = spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).endsWith("getReceipts")) return Response.json({ data: { "provider-1": { status: "ok" } } })
    sent.push(JSON.parse(String(options?.body)))
    return Response.json({ data: { status: "ok", id: "provider-1" } })
  })
  try {
    const device = await f.subscribe()
    const { ticket, conversation } = await f.handoff()
    await Promise.all([drainInboxPush(f.database), drainInboxPush(f.database)])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(device.token)
    expect(sent[0]!.data).toEqual({ projectId: f.projectId, ticketId: ticket.id })
    expect(JSON.stringify(sent)).not.toContain("Private customer details")
    expect((await f.database.execute(sql`select status from inbox_mobile_push_jobs`)).rows[0]!.status).toBe("receipt")
    await f.database.execute(sql`update inbox_mobile_push_jobs set available_at=now()`)
    await drainInboxPush(f.database)
    expect((await f.database.execute(sql`select status from inbox_mobile_push_jobs`)).rows[0]!.status).toBe("accepted")
    await takeoverConversation(f.context, { conversationId: conversation.id })
    await assert.rejects(() => takeoverConversation({ ...f.context, actorId: "another-human" }, { conversationId: conversation.id }), /currently owned by another agent/)
    await drainInboxPush(f.database)
    expect(sent).toHaveLength(1)
  } finally { provider.mockRestore(); await closeTracerFixture(f.database) }
}, 20_000)

test("assignment alerts go only to the current assignee; removed members and revoked sessions receive nothing", async () => {
  const f = await fixture()
  const sent: Record<string, unknown>[] = []
  const provider = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    return Response.json({ data: { status: "ok", id: crypto.randomUUID() } })
  })
  try {
    const otherId = crypto.randomUUID()
    await f.database.execute(sql`insert into "user"(id,name,email) values (${otherId},'Other',${otherId + "@example.test"})`)
    await f.database.execute(sql`insert into member(id,"organizationId","userId",role,"createdAt") values (${crypto.randomUUID()},${f.organizationId},${otherId},'member',now())`)
    const ownerDevice = await f.subscribe()
    const otherDevice = await f.subscribe(otherId)
    const first = await f.handoff()
    await assignTicket(f.context, { ticketId: first.ticket.id, assigneeUserId: otherId, expectedVersion: first.ticket.version })
    await drainInboxPush(f.database)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every(payload => payload.to === otherDevice.token)).toBe(true)
    expect(sent.some(payload => payload.to === ownerDevice.token)).toBe(false)
    sent.length = 0
    await f.handoff()
    await f.database.execute(sql`delete from member where "userId"=${otherId}`)
    await f.database.execute(sql`delete from session where id=${ownerDevice.sessionId}`)
    await drainInboxPush(f.database)
    expect(sent).toHaveLength(0)
  } finally { provider.mockRestore(); await closeTracerFixture(f.database) }
}, 20_000)

test("failed pushes retry durably; stale tokens are removed; new subscriptions do not receive old handoffs", async () => {
  const f = await fixture()
  let fail = true, calls = 0
  const provider = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls++
    if (fail) throw new Error("Network unavailable")
    return Response.json({ data: { status: "error", details: { error: "DeviceNotRegistered" } } })
  })
  try {
    const device = await f.subscribe()
    await f.handoff()
    await drainInboxPush(f.database)
    const pending = (await f.database.execute(sql`select status,attempts from inbox_mobile_push_jobs`)).rows[0]!
    expect(pending).toEqual({ status: "pending", attempts: 1 })
    fail = false
    await f.database.execute(sql`update inbox_mobile_push_jobs set available_at=now()`)
    await drainInboxPush(f.database)
    expect((await f.database.execute(sql`select id from inbox_mobile_devices where token=${device.token}`)).rows).toHaveLength(0)
    await f.handoff()
    await f.subscribe()
    calls = 0
    await drainInboxPush(f.database)
    expect(calls).toBe(0)
  } finally { provider.mockRestore(); await closeTracerFixture(f.database) }
}, 20_000)

test("mobile HTTP routes authorize a real Better Auth session without crossing project boundaries", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-env-file", "run", "tests/helpers/inbox-mobile-http.ts"], {
        env: { ...process.env, DATABASE_URL: target.databaseUrl, NODE_ENV: "production", BETTER_AUTH_URL: "https://datool.test", BETTER_AUTH_SECRET: "inbox-mobile-isolated-test-secret-not-for-production", GOOGLE_CLIENT_ID: "mobile-fixture.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "mobile-fixture-not-a-real-secret" }, stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      child.stdout.on("data", data => { output += data })
      child.stderr.on("data", data => { output += data })
      child.on("error", reject)
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(output)))
    })
  } finally { await target.close() }
}, 30_000)

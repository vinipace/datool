import { afterEach, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import { ConversationService } from "@/src/server/build/conversations"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

let target: IsolatedPostgres | undefined
const databases: TracerDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map(closeTracerDatabase))
  await target?.close()
  target = undefined
})

test("combined sessions deduplicate chats and preserve scoped filtering, counts and newest-first pagination", async () => {
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  databases.push(database)
  const tracer = new TracerService(database)
  const context = { database, projectId: target.projectId }
  await createAgent(context, {
    id: "support",
    name: "Support",
    slug: "support",
  })
  const ledger = new ConversationService(context)
  const traced = await ledger.getOrCreate({
    agentId: "support",
    channel: "web",
    metadata: {},
  })
  const untraced = await ledger.getOrCreate({
    agentId: "support",
    channel: "api",
    metadata: {},
  })
  await ledger.appendMessage(traced.id, {
    role: "user",
    content: "Refund question",
    status: "completed",
    metadata: {},
  })
  await runTracerEffect(
    tracer.createSession({ id: traced.id, name: "Support web", attributes: {} })
  )
  await runTracerEffect(
    tracer.createTrace({
      id: "chat-turn",
      sessionId: traced.id,
      name: "Reply",
      operation: "build.agent.turn",
      status: "completed",
    })
  )
  await runTracerEffect(
    tracer.createSession({
      id: "sdk-session",
      name: "Checkout flow",
      attributes: { source: "sdk" },
    })
  )

  // A different project's conversation with the SDK row's ID must not hide it.
  const foreignProjectId = crypto.randomUUID()
  await database.execute(sql`insert into project (id, organization_id, name, slug)
    values (${foreignProjectId}, ${target.organizationId}, 'Other', 'other')`)
  const other = createTracerDatabase(target.databaseUrl, {
    projectId: foreignProjectId,
    schema: target.schema,
  })
  databases.push(other)
  await createAgent(
    { database: other, projectId: foreignProjectId },
    { id: "other-agent", name: "Private agent", slug: "private" }
  )
  await other.execute(sql`insert into build_conversations (project_id, id, agent_id, channel)
    values (${foreignProjectId}, 'sdk-session', 'other-agent', 'web')`)
  await runTracerEffect(
    new TracerService(other).createSession({
      id: "private-session",
      name: "Private session",
      attributes: {},
    })
  )

  // Sub-millisecond order must survive the shared SQL cursor, including a tie.
  await database.execute(sql`update sessions set updated_at = '2026-10-30 12:00:00.123455+00'
    where project_id = ${target.projectId}`)
  await database.execute(sql`update build_conversations set updated_at = case
    when id = ${traced.id} then '2026-10-30 12:00:00.123456+00'::timestamptz
    else '2026-10-30 12:00:00.123455+00'::timestamptz end
    where project_id = ${target.projectId}`)
  const all = await runTracerEffect(
    tracer.listSessionActivity({ includeTotal: true })
  )
  const expected = [traced.id, ...[untraced.id, "sdk-session"].sort().reverse()]
  expect(all.total).toBe(3)
  expect(all.items.map(({ id }) => id)).toEqual(expected)
  expect(all.items[0]).toMatchObject({
    name: "Refund question",
    traceCount: 1,
    conversation: {
      agentName: "Support",
      channel: "web",
      status: "active",
      ticketId: null,
    },
  })
  expect(all.items.find(({ id }) => id === untraced.id)).toMatchObject({
    traceCount: 0,
    conversation: { channel: "api" },
  })
  expect(
    all.items.find(({ id }) => id === "sdk-session")?.conversation
  ).toBeNull()

  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page: typeof all = await runTracerEffect(
      tracer.listSessionActivity({ limit: 1, cursor })
    )
    ids.push(...page.items.map(({ id }) => id))
    cursor = page.nextCursor
  } while (cursor)
  expect(ids).toEqual(expected)
  const filtered = await runTracerEffect(
    tracer.listSessionActivity({
      filter: 'channel = "web" name : "Refund"',
      includeTotal: true,
      limit: 1,
    })
  )
  expect(filtered.items.map(({ id }) => id)).toEqual([traced.id])
  expect(filtered.total).toBe(1)
  expect(filtered.nextCursor).toBeNull()
  const legacy = await runTracerEffect(tracer.listSessions())
  expect(legacy.items.map(({ id }) => id).sort()).toEqual(
    [traced.id, "sdk-session"].sort()
  )
  expect("conversation" in legacy.items[0]).toBe(false)
}, 30_000)

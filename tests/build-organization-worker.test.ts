import { afterEach, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import { createBuildContext } from "@/src/server/build/context"
import { ConversationService } from "@/src/server/build/conversations"
import {
  claimNextChannelJob,
  completeChannelJob,
  createChannelConnection,
  enqueueConversationWaitJobs,
  enqueueTelegramPollingJobs,
} from "@/src/server/build/channels/service"
import { listSimulationProjectsWithPendingRuns } from "@/src/server/build/testing/service"
import { listCampaignProjectsWithPendingWork } from "@/src/server/build/operations/campaigns"
import { listKnowledgeProjectsWithPendingWork } from "@/src/server/build/knowledge/service"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import { configureBuildTestEnvironment } from "./helpers/build-env"

configureBuildTestEnvironment("false")
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const target = await createIsolatedPostgres()
  cleanup.push(() => target.close())
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  cleanup.push(() => closeTracerDatabase(database))
  const tenants = []
  for (const [index, prefix] of ["a-excluded", "z-enabled"].entries()) {
    const organizationId = `${prefix}-${crypto.randomUUID()}`
    const projectId = `${prefix}-${crypto.randomUUID()}`
    await database.execute(
      sql`insert into organization(id,name,slug,"createdAt") values(${organizationId},${prefix},${organizationId},now())`
    )
    await database.execute(
      sql`insert into project(id,organization_id,name,slug) values(${projectId},${organizationId},${prefix},${prefix})`
    )
    const scoped = createTracerDatabase(target.databaseUrl, {
      projectId,
      schema: target.schema,
    })
    cleanup.push(() => closeTracerDatabase(scoped))
    const context = createBuildContext(scoped, { organizationId })
    const agent = await createAgent(context, {
      name: "Rollout agent",
      configuration: { instructions: "Fixture", model: "test-model" },
    })
    const connection = await createChannelConnection(context, {
      agentId: agent.id,
      channel: "telegram",
      label: "Fixture",
    })
    await database.execute(
      sql`update build_channel_connection set status='connected',webhook_mode='polling' where id=${connection.id}::uuid`
    )
    const due = new Date(Date.now() - (index === 0 ? 120_000 : 60_000))
    tenants.push({ organizationId, projectId, context, agent, connection, due })
  }
  const [excluded, allowed] = tenants
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = allowed.organizationId
  return { database, excluded, allowed, tenants }
}

test("worker claims only enabled jobs and leaves excluded retries and stale deliveries untouched", async () => {
  const { database, excluded, allowed, tenants } = await fixture()
  for (const tenant of tenants) {
    await database.execute(sql`insert into build_channel_job(id,project_id,connection_id,kind,idempotency_key,run_after)
      values(${crypto.randomUUID()}::uuid,${tenant.projectId},${tenant.connection.id}::uuid,'process_inbound','queued',${tenant.due})`)
    await database.execute(sql`insert into build_channel_job(id,project_id,connection_id,kind,idempotency_key,status,locked_at,attempts)
      values(${crypto.randomUUID()}::uuid,${tenant.projectId},${tenant.connection.id}::uuid,'deliver_outbound','stale','running',now()-interval '10 minutes',1)`)
  }
  const job = await claimNextChannelJob(database)
  expect(job?.projectId).toBe(allowed.projectId)
  expect(job?.attempts).toBe(1)
  await completeChannelJob(database, job!)
  expect(await claimNextChannelJob(database)).toBeNull()
  const state = await database.execute(
    sql`select idempotency_key,status,attempts from build_channel_job where project_id=${excluded.projectId} order by idempotency_key`
  )
  expect(state.rows).toEqual([
    { idempotency_key: "queued", status: "queued", attempts: 0 },
    { idempotency_key: "stale", status: "running", attempts: 1 },
  ])
  // Existing queued work becomes eligible without rewriting it.
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = excluded.organizationId
  expect((await claimNextChannelJob(database))?.projectId).toBe(
    excluded.projectId
  )
}, 30_000)

test("polling and procedure waits are admitted only for enabled organizations", async () => {
  const { database, excluded, allowed, tenants } = await fixture()
  for (const tenant of tenants) {
    const service = new ConversationService(tenant.context)
    const conversationId = crypto.randomUUID()
    await database.execute(sql`insert into build_conversations(id,project_id,agent_id,channel,metadata_json)
      values(${conversationId},${tenant.projectId},${tenant.agent.id},'telegram',${JSON.stringify({ connectionId: tenant.connection.id })}::jsonb)`)
    const turn = await service.startTurn(conversationId, {
      requestKey: "wait",
      input: "wait",
      metadata: {},
      snapshot: {
        agentId: tenant.agent.id,
        agentRevision: 1,
        channel: "telegram",
      },
    })
    await service.recordToolCallStart({
      conversationId,
      turnId: turn.turn.id,
      toolCallId: "wait",
      actionId: "__wait__",
      args: {},
      ownerFence: turn.turn.ownerFence,
    })
    await service.recordToolCallFinish({
      conversationId,
      turnId: turn.turn.id,
      toolCallId: "wait",
      status: "awaiting_client",
      output: {},
      continuation: {
        type: "wait",
        actionId: "__wait__",
        continuationId: crypto.randomUUID(),
        resumeAt: new Date(0).toISOString(),
      },
      ownerFence: turn.turn.ownerFence,
    })
  }
  expect(await enqueueTelegramPollingJobs(database)).toBe(1)
  expect(await enqueueConversationWaitJobs(database, { limit: 1 })).toBe(1)
  const jobs = await database.execute(
    sql`select project_id,kind from build_channel_job order by kind`
  )
  expect(jobs.rows).toEqual([
    { project_id: allowed.projectId, kind: "resume_wait" },
    { project_id: allowed.projectId, kind: "telegram_poll" },
  ])
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = excluded.organizationId
  expect(await enqueueTelegramPollingJobs(database)).toBe(1)
  expect(await enqueueConversationWaitJobs(database, { limit: 1 })).toBe(1)
}, 30_000)

test("knowledge, simulations and campaigns filter before limits and preserve pending work", async () => {
  const { database, excluded, allowed, tenants } = await fixture()
  for (const tenant of tenants) {
    const source = crypto.randomUUID(),
      definition = crypto.randomUUID()
    await database.execute(sql`insert into build_knowledge_sources(id,project_id,agent_id,kind,name,next_resync_at)
      values(${source},${tenant.projectId},${tenant.agent.id},'website','Fixture',${tenant.due})`)
    await database.execute(sql`insert into build_knowledge_jobs(id,project_id,source_id,kind,queued_at)
      values(${crypto.randomUUID()},${tenant.projectId},${source},'index',${tenant.due})`)
    await database.execute(sql`insert into build_test_definitions(id,project_id,agent_id,revision,name,definition_json,status)
      values(${definition},${tenant.projectId},${tenant.agent.id},1,'Fixture','{}','active')`)
    await database.execute(sql`insert into build_test_runs(id,project_id,definition_id,status,requested_cases,config_snapshot_json,created_at)
      values(${crypto.randomUUID()},${tenant.projectId},${definition},'queued',1,'{}',${tenant.due})`)
    await database.execute(sql`insert into build_campaigns(id,project_id,name,channel,status,scheduled_at)
      values(${crypto.randomUUID()},${tenant.projectId},'Fixture','telegram','scheduled',${tenant.due})`)
  }
  const selectors = [
    listKnowledgeProjectsWithPendingWork,
    listSimulationProjectsWithPendingRuns,
    listCampaignProjectsWithPendingWork,
  ]
  for (const select of selectors) {
    expect(await select(database, 1)).toEqual([allowed.projectId])
  }
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = ""
  for (const select of selectors) expect(await select(database, 1)).toEqual([])
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = excluded.organizationId
  for (const select of selectors)
    expect(await select(database, 1)).toEqual([excluded.projectId])
  process.env.DATOOL_BUILD_ENABLED = "true"
  for (const select of selectors)
    expect(new Set(await select(database))).toEqual(
      new Set(tenants.map((tenant) => tenant.projectId))
    )
}, 30_000)

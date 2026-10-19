import { strict as assert } from "node:assert"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"

import { createAgent } from "@/src/server/build/agents"
import { createChannelConnection } from "@/src/server/build/channels/service"
import { getTracerProjectId } from "@/src/server/tracer/db"
import {
  getBuildHealth,
  listDeliveryFailures,
  retryDelivery,
} from "@/src/server/build/operations/health"
import {
  createTicket,
  sendHumanReply,
  takeoverConversation,
} from "@/src/server/build/operations/inbox"
import { closeTracerFixture, createTracerFixture } from "./helpers/tracer-fixture"

const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const safeJobId = "11111111-1111-4111-8111-111111111111"
const uncertainJobId = "22222222-2222-4222-8222-222222222222"

async function channelFixture() {
  process.env.BETTER_AUTH_SECRET = "b".repeat(64)
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId, actorId: "health-operator" }
  const agent = await createAgent(context, {
    id: "health-agent",
    name: "Health agent",
    slug: "health-agent",
    configuration: { model: "openai/gpt-4.1-mini" },
  })
  const connection = await createChannelConnection(context, {
    id: connectionId,
    agentId: agent.id,
    channel: "telegram",
    label: "Health bot",
    credentials: { token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  })
  await database.execute(sql`
    update build_channel_connection
    set status='connected'
    where project_id=${projectId} and id=${connection.id}::uuid
  `)
  return { database, context, projectId, agent, connection }
}

test("Build health mirrors worker backlog predicates and keeps uncertain delivery visible", async () => {
  const { database, context, projectId, agent, connection } = await channelFixture()
  try {
    await database.execute(sql`
      insert into build_knowledge_sources
        (id,project_id,agent_id,kind,name,content_text,status)
      values
        ('health-source',${projectId},${agent.id},'text','Health source','hello','ready')
    `)
    await database.execute(sql`
      insert into build_knowledge_jobs
        (id,project_id,source_id,kind,status,queued_at)
      values
        ('knowledge-queued',${projectId},'health-source','index','queued',now()-interval '10 minutes'),
        ('knowledge-failed',${projectId},'health-source','resync','failed',now()-interval '9 minutes')
    `)
    await database.execute(sql`
      insert into build_test_definitions
        (id,project_id,agent_id,revision,name,definition_json,status)
      values
        ('health-simulation',${projectId},${agent.id},1,'Health simulation','{}'::jsonb,'active')
    `)
    await database.execute(sql`
      insert into build_test_runs
        (id,project_id,definition_id,status,requested_cases,config_snapshot_json,created_at)
      values
        ('simulation-queued',${projectId},'health-simulation','queued',1,'{}'::jsonb,now()-interval '8 minutes'),
        ('simulation-failed',${projectId},'health-simulation','failed',1,'{}'::jsonb,now()-interval '7 minutes')
    `)
    await database.execute(sql`
      insert into build_conversations
        (id,project_id,agent_id,channel,external_conversation_id)
      values
        ('health-conversation',${projectId},${agent.id},'telegram','health-chat')
    `)
    await database.execute(sql`
      insert into build_channel_job
        (id,project_id,connection_id,kind,payload_json,idempotency_key,status,run_after,created_at)
      values
        ('44444444-4444-4444-8444-444444444444',${projectId},${connection.id}::uuid,'telegram_poll','{}'::jsonb,'health-queued','queued',now()-interval '6 minutes',now()-interval '6 minutes')
    `)
    await database.execute(sql`
      insert into build_contacts(id,project_id,external_id,display_name)
      values ('health-contact',${projectId},'telegram:health','Health contact')
    `)
    await database.execute(sql`
      insert into build_campaigns
        (id,project_id,name,channel,status,scheduled_at)
      values
        ('health-campaign',${projectId},'Health campaign','telegram','scheduled',now()-interval '5 minutes')
    `)
    await database.execute(sql`
      insert into build_campaign_audience
        (id,project_id,campaign_id,contact_id,state)
      values
        ('health-audience',${projectId},'health-campaign','health-contact','eligible')
    `)
    await database.execute(sql`
      insert into build_campaign_deliveries
        (id,project_id,campaign_id,audience_id,channel,idempotency_key,state,last_error)
      values
        ('health-delivery',${projectId},'health-campaign','health-audience','telegram','health-delivery','failed','provider rejected')
    `)

    const health = await getBuildHealth(context)
    expect(health.status).toBe("degraded")
    expect(health.queues.knowledge).toMatchObject({ backlog: 1, failed: 1, uncertain: 0 })
    expect(typeof health.queues.knowledge.oldestJobAt).toBe("string")
    expect(health.queues.channel).toMatchObject({ backlog: 1, failed: 0, uncertain: 0 })
    expect(health.queues.simulation).toMatchObject({ backlog: 1, failed: 1, uncertain: 0 })
    expect(health.queues.campaign).toMatchObject({ backlog: 1, failed: 1, uncertain: 0 })

    await database.execute(sql`
      insert into build_channel_message
        (id,project_id,connection_id,conversation_id,direction,idempotency_key,content_json,status,error_code)
      values
        ('safe-message',${projectId},${connection.id}::uuid,'health-conversation','outbound','safe-message','{"text":"secret text","metadata":{"token":"secret"}}'::jsonb,'failed','INVALID_CREDENTIAL'),
        ('uncertain-message',${projectId},${connection.id}::uuid,'health-conversation','outbound','uncertain-message','{"text":"uncertain text","metadata":{"token":"secret"}}'::jsonb,'uncertain','NETWORK_ERROR')
    `)
    await database.execute(sql`
      insert into build_channel_job
        (id,project_id,connection_id,kind,message_id,payload_json,idempotency_key,status,last_error)
      values
        (${safeJobId}::uuid,${projectId},${connection.id}::uuid,'deliver_outbound','safe-message','{"token":"secret","text":"secret text"}'::jsonb,'safe-job','failed','Provider said no'),
        (${uncertainJobId}::uuid,${projectId},${connection.id}::uuid,'deliver_outbound','uncertain-message','{"token":"secret","text":"uncertain text"}'::jsonb,'uncertain-job','uncertain','request outcome uncertain')
    `)
    const blockedHealth = await getBuildHealth(context)
    expect(blockedHealth.status).toBe("blocked")
    expect(blockedHealth.queues.channel).toMatchObject({ backlog: 1, failed: 1, uncertain: 1 })
    const failures = await listDeliveryFailures(context, { limit: 10 })
    expect(failures.items).toHaveLength(2)
    const safe = failures.items.find((item) => item.jobId === safeJobId)
    const uncertain = failures.items.find((item) => item.jobId === uncertainJobId)
    expect(safe).toMatchObject({ status: "failed", failureCode: "INVALID_CREDENTIAL", retryAllowed: true })
    expect(uncertain).toMatchObject({ status: "uncertain", failureCode: "NETWORK_ERROR", retryAllowed: false })
    const serialized = JSON.stringify(failures)
    expect(serialized).not.toContain("secret")
    expect(Object.prototype.hasOwnProperty.call(safe, "payload")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(safe, "lastError")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(safe, "providerMessageId")).toBe(false)
  } finally {
    await closeTracerFixture(database)
  }
})

test("delivery retry only requeues a known pre-send failure and never uncertain delivery", async () => {
  const { database, context, projectId, agent, connection } = await channelFixture()
  try {
    await database.execute(sql`
      insert into build_conversations
        (id,project_id,agent_id,channel,external_conversation_id)
      values ('retry-conversation',${projectId},${agent.id},'telegram','retry-chat')
    `)
    await database.execute(sql`
      insert into build_channel_message
        (id,project_id,connection_id,conversation_id,direction,idempotency_key,content_json,status,error_code)
      values
        ('retry-message',${projectId},${connection.id}::uuid,'retry-conversation','outbound','retry-message','{"text":"retry me"}'::jsonb,'failed','INVALID_CREDENTIAL'),
        ('uncertain-retry-message',${projectId},${connection.id}::uuid,'retry-conversation','outbound','uncertain-retry-message','{"text":"do not duplicate"}'::jsonb,'uncertain','NETWORK_ERROR')
    `)
    await database.execute(sql`
      insert into build_channel_job
        (id,project_id,connection_id,kind,message_id,payload_json,idempotency_key,status,last_error)
      values
        (${safeJobId}::uuid,${projectId},${connection.id}::uuid,'deliver_outbound','retry-message','{"text":"retry me"}'::jsonb,'retry-job','failed','Provider rejected credential'),
        (${uncertainJobId}::uuid,${projectId},${connection.id}::uuid,'deliver_outbound','uncertain-retry-message','{"text":"do not duplicate"}'::jsonb,'uncertain-retry-job','uncertain','Outcome uncertain')
    `)

    const retried = await retryDelivery(context, { jobId: safeJobId, expectedCode: "INVALID_CREDENTIAL" })
    expect(retried).toMatchObject({ jobId: safeJobId, messageId: "retry-message", status: "queued", retryAllowed: true })
    const queued = await database.execute<{ job_status: string; message_status: string; provider_message_id: string | null }>(sql`
      select j.status as job_status,m.status as message_status,m.provider_message_id
      from build_channel_job j join build_channel_message m on m.project_id=j.project_id and m.id=j.message_id
      where j.project_id=${projectId} and j.id=${safeJobId}::uuid
    `)
    expect(queued.rows[0]).toEqual({ job_status: "queued", message_status: "queued", provider_message_id: null })
    await assert.rejects(
      retryDelivery(context, { jobId: uncertainJobId, expectedCode: "INVALID_CREDENTIAL" }),
      /uncertain/i,
    )
  } finally {
    await closeTracerFixture(database)
  }
})

test("human replies stop at an expired conversation lease even when the stale owner is still recorded", async () => {
  const { database, context, projectId, agent, connection } = await channelFixture()
  try {
    await database.execute(sql`
      insert into build_conversations
        (id,project_id,agent_id,channel,external_conversation_id)
      values ('lease-conversation',${projectId},${agent.id},'telegram','lease-chat')
    `)
    const ticket = await createTicket(context, { conversationId: "lease-conversation", channel: "telegram" })
    const ownership = await takeoverConversation(context, { conversationId: "lease-conversation" })
    await database.execute(sql`
      update build_conversation_ownership
      set lease_expires_at=now()-interval '1 second'
      where project_id=${projectId} and conversation_id='lease-conversation'
    `)
    expect(ticket.conversationId).toBe("lease-conversation")
    await assert.rejects(
      sendHumanReply({ ...context, idempotencyKey: "expired-lease" }, {
        conversationId: "lease-conversation",
        connectionId: connection.id,
        text: "This must not be appended.",
      }),
      /lease is no longer active/i,
    )
    expect(ownership?.mode).toBe("human")
  } finally {
    await closeTracerFixture(database)
  }
})

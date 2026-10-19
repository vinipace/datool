import { afterEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"

import { sql } from "drizzle-orm"

import { createAgent } from "@/src/server/build/agents"
import { ConversationService } from "@/src/server/build/conversations"
import { createBuildContext } from "@/src/server/build/context"
import {
  claimNextChannelJob,
  completeChannelJob,
  createChannelConnection,
  enqueueConversationWaitJobs,
  enqueueTelegramUpdate,
  failChannelJob,
  processChannelJob,
} from "@/src/server/build/channels/service"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: Array<{ database: TracerDatabase; target: IsolatedPostgres }> =
  []
const token = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function fixture() {
  process.env.BETTER_AUTH_SECRET = "b".repeat(64)
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  const context = createBuildContext(database, {
    organizationId: target.organizationId,
    actorId: target.ownerId,
  })
  const agent = await createAgent(context, {
    id: "agent-wait",
    name: "Wait agent",
    slug: "wait-agent",
    configuration: {
      instructions: "Answer briefly.",
      model: "openai/gpt-4.1-mini",
    },
  })
  const connection = await createChannelConnection(context, {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    agentId: agent.id,
    channel: "telegram",
    label: "Wait bot",
    credentials: { token },
    config: { mode: "webhook" },
  })
  await database.execute(sql`
    UPDATE build_channel_connection
    SET status = 'connected'
    WHERE project_id = ${context.projectId} AND id = ${connection.id}::uuid
  `)
  return { database, context, connection, agent }
}

describe("durable Build procedure waits", () => {
  test("schedules one wait job and resumes it through the channel outbox", async () => {
    const { database, context, connection, agent } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      update_id: 501,
      message: {
        message_id: 1,
        chat: { id: 7001, type: "private" },
        from: { id: 7002, first_name: "Ada" },
        text: "start timer",
      },
    })
    if (!("conversationId" in accepted))
      throw new Error("Expected a conversation for the wait fixture.")
    const conversationId = accepted.conversationId
    const service = new ConversationService(context)
    const admission = await service.startTurn(conversationId, {
      requestKey: "wait-fixture-turn",
      input: "start timer",
      metadata: {},
      snapshot: { agentId: agent.id, agentRevision: 1, channel: "telegram" },
    })
    const continuationId = "wait-continuation-501"
    const toolCallId = "wait-tool-call-501"
    await service.recordToolCallStart({
      conversationId,
      turnId: admission.turn.id,
      toolCallId,
      actionId: "__wait__",
      args: { seconds: 1 },
      ownerFence: admission.turn.ownerFence,
    })
    await service.recordToolCallFinish({
      conversationId,
      turnId: admission.turn.id,
      toolCallId,
      status: "awaiting_client",
      output: {
        type: "wait",
        actionId: "__wait__",
        continuationId,
        seconds: 1,
        resumeAt: new Date(0).toISOString(),
      },
      continuation: {
        type: "wait",
        actionId: "__wait__",
        continuationId,
        seconds: 1,
        resumeAt: new Date(0).toISOString(),
      },
      ownerFence: admission.turn.ownerFence,
    })

    expect(await enqueueConversationWaitJobs(database)).toBe(1)
    expect(await enqueueConversationWaitJobs(database)).toBe(0)
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("resume_wait")
    if (!job) return
    let received: { continuationId: string; requestKey: string } | undefined
    const result = await processChannelJob(
      job,
      async () => ({ messages: [] }),
      database,
      {
        resumeWait: async (input) => {
          received = {
            continuationId: input.continuationId,
            requestKey: input.requestKey,
          }
          return {
            status: "completed",
            conversation: await service.require(conversationId),
            turn: admission.turn,
            message: null,
            text: "The timer elapsed.",
            continuations: [],
            toolCalls: [],
            traceId: null,
            usage: {},
            replayed: false,
          }
        },
      }
    )
    expect(received).toEqual({
      continuationId,
      requestKey: `channel:${job.id}`,
    })
    expect(result).toMatchObject({ queued: true, status: "completed" })
    await completeChannelJob(database, job)

    const outbox = await database.execute<{
      text: string
      idempotency_key: string
      status: string
    }>(sql`
      SELECT content_json->>'text' AS text, idempotency_key, status
      FROM build_channel_message
      WHERE project_id = ${context.projectId} AND direction = 'outbound'
    `)
    expect(outbox.rows).toEqual([
      {
        text: "The timer elapsed.",
        idempotency_key: `wait:${conversationId}:${continuationId}`,
        status: "queued",
      },
    ])
  }, 30_000)

  test("repairs a wait handoff after the resume worker crashes before enqueue", async () => {
    const { database, context, connection, agent } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      update_id: 502,
      message: {
        message_id: 2,
        chat: { id: 7003, type: "private" },
        from: { id: 7004, first_name: "Bea" },
        text: "start handoff timer",
      },
    })
    if (!("conversationId" in accepted))
      throw new Error("Expected a conversation for the wait fixture.")
    const conversationId = accepted.conversationId
    const inboundJob = await claimNextChannelJob(database)
    expect(inboundJob?.kind).toBe("process_inbound")
    if (inboundJob) await completeChannelJob(database, inboundJob)
    const service = new ConversationService(context)
    const initial = await service.startTurn(conversationId, {
      requestKey: "wait-fixture-turn-502",
      input: "start handoff timer",
      metadata: {},
      snapshot: { agentId: agent.id, agentRevision: 1, channel: "telegram" },
    })
    const continuationId = "wait-continuation-502"
    await service.recordToolCallStart({
      conversationId,
      turnId: initial.turn.id,
      toolCallId: "wait-tool-call-502",
      actionId: "__wait__",
      args: { seconds: 1 },
      ownerFence: initial.turn.ownerFence,
    })
    await service.recordToolCallFinish({
      conversationId,
      turnId: initial.turn.id,
      toolCallId: "wait-tool-call-502",
      status: "awaiting_client",
      output: {
        type: "wait",
        actionId: "__wait__",
        continuationId,
        seconds: 1,
        resumeAt: new Date(0).toISOString(),
      },
      continuation: {
        type: "wait",
        actionId: "__wait__",
        continuationId,
        seconds: 1,
        resumeAt: new Date(0).toISOString(),
      },
      ownerFence: initial.turn.ownerFence,
    })
    await service.finishTurn({
      turnId: initial.turn.id,
      ownerFence: initial.turn.ownerFence,
      status: "awaiting_client",
      outputMessageId: null,
      usage: {},
    })
    expect(await enqueueConversationWaitJobs(database)).toBe(1)
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("resume_wait")
    if (!job) return

    await assert.rejects(
      processChannelJob(job, async () => ({ messages: [] }), database, {
        resumeWait: async (input) => {
          const resumed = await service.startTurn(conversationId, {
            requestKey: input.requestKey,
            input: "The wait elapsed.",
            metadata: {},
            snapshot: {
              agentId: agent.id,
              agentRevision: 1,
              channel: "telegram",
            },
          })
          const handoff = {
            type: "handoff" as const,
            actionId: "handoff_support",
            continuationId: "handoff-after-wait-502",
            teamId: "team-support",
            message: "A human teammate will help next.",
          }
          await service.recordToolCallStart({
            conversationId,
            turnId: resumed.turn.id,
            toolCallId: "handoff-tool-call-502",
            actionId: handoff.actionId,
            args: {},
            ownerFence: resumed.turn.ownerFence,
          })
          await service.recordToolCallFinish({
            conversationId,
            turnId: resumed.turn.id,
            toolCallId: "handoff-tool-call-502",
            status: "completed",
            output: handoff,
            continuation: handoff,
            ownerFence: resumed.turn.ownerFence,
          })
          const message = await service.appendMessage(
            conversationId,
            {
              role: "assistant",
              content: handoff.message,
              turnId: resumed.turn.id,
              status: "completed",
              metadata: {},
            },
            { ownerFence: resumed.turn.ownerFence }
          )
          await service.finishTurn({
            turnId: resumed.turn.id,
            ownerFence: resumed.turn.ownerFence,
            status: "awaiting_client",
            outputMessageId: message.id,
            usage: {},
          })
          await service.claim(
            conversationId,
            {
              type: "human",
              id: "team-support",
              reason: "Agent handoff action",
            },
            {
              expectedOwnerFence: resumed.turn.ownerFence,
              expectedOwnerType: "ai",
              handoffTurnId: resumed.turn.id,
            }
          )
          throw new Error("simulated wait worker crash after handoff")
        },
      })
    )
    await failChannelJob(database, job, {
      code: "NETWORK_ERROR",
      message: "simulated wait worker crash",
    })
    await database.execute(sql`
      UPDATE build_channel_job
      SET run_after = now()
      WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid
    `)
    const retry = await claimNextChannelJob(database)
    expect(retry?.kind).toBe("resume_wait")
    if (!retry) return
    let rerun = false
    const repaired = await processChannelJob(
      retry,
      async () => ({ messages: [] }),
      database,
      {
        resumeWait: async () => {
          rerun = true
          throw new Error("must not resume a committed handoff again")
        },
      }
    )
    await completeChannelJob(database, retry)
    expect(repaired).toEqual({ outputMessages: 1, status: "handed_off" })
    expect(rerun).toBe(false)

    const state = await database.execute<{
      owner_type: string
      owner_fence: string
      outbound_count: string
      outbound_text: string
    }>(sql`
      SELECT
        (SELECT owner_type FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${conversationId}) AS owner_type,
        (SELECT owner_fence::text FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${conversationId}) AS owner_fence,
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${conversationId} AND direction = 'outbound') AS outbound_count,
        (SELECT max(content_json->>'text') FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${conversationId} AND direction = 'outbound') AS outbound_text
    `)
    expect(state.rows[0]).toEqual({
      owner_type: "human",
      owner_fence: "3",
      outbound_count: "1",
      outbound_text: "A human teammate will help next.",
    })
  }, 30_000)
})

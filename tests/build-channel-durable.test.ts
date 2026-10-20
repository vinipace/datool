import { afterEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"

import { sql } from "drizzle-orm"

import { createAgent } from "@/src/server/build/agents"
import { ConversationService } from "@/src/server/build/conversations"
import {
  runAgentTurn,
  type RuntimeDependencies,
} from "@/src/server/build/runtime"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  createRoutingRule,
  createTeam,
  setTeamMember,
} from "@/src/server/build/operations/teams"
import { createBuildContext } from "@/src/server/build/context"
import {
  claimNextChannelJob,
  completeChannelJob,
  assertPublicOrigin,
  createChannelConnection,
  updateChannelConnection,
  getChannelConnection,
  registerTelegramConnection,
  getPublicChatAppearance,
  updateChannelStatus,
  enqueueTelegramUpdate,
  enqueueTelegramPollingJobs,
  enqueuePublicMessage,
  createPublicSession,
  enqueueAgentTurnResult,
  PublicAdmissionRateLimitError,
  publicChatContentSecurityPolicy,
  enqueueOutboundEnvelope,
  readPublicConversation,
  listPublicConversations,
  resetPublicConversation,
  recordPublicFeedback,
  failChannelJob,
  processChannelJob,
  verifyTelegramWebhookSecret,
} from "@/src/server/build/channels/service"
import { encryptChannelCredentials } from "@/src/server/build/channels/secrets"
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
    id: "agent-telegram",
    name: "Telegram support",
    slug: "telegram-support",
    configuration: {
      instructions: "Answer briefly.",
      model: "openai/gpt-4.1-mini",
      appearance: {
        displayName: "Inherited support",
        welcomeMessage: "Hello from the agent",
      },
    },
  })
  const connection = await createChannelConnection(context, {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentId: agent.id,
    channel: "telegram",
    label: "Support bot",
    credentials: { token },
    config: { mode: "webhook" },
  })
  await database.execute(sql`
    UPDATE build_channel_connection
    SET status = 'connected'
    WHERE project_id = ${context.projectId} AND id = ${connection.id}::uuid
  `)
  return { database, context, connection }
}

const update = {
  update_id: 77,
  message: {
    message_id: 11,
    chat: { id: 9001, type: "private" },
    from: { id: 9002, first_name: "Ada", username: "ada" },
    text: "Where is my order?",
  },
}

describe("durable Build channel delivery", () => {
  test("serves messages ahead of background polls and coalesces polling while a job is outstanding", async () => {
    const { database, context, connection } = await fixture()
    await database.execute(
      sql`UPDATE build_channel_connection SET webhook_mode='polling' WHERE id=${connection.id}::uuid`
    )
    expect(await enqueueTelegramPollingJobs(database)).toBe(1)
    // An outstanding poll from an earlier scheduling bucket must not multiply on retry.
    await database.execute(
      sql`UPDATE build_channel_job SET id=gen_random_uuid(),idempotency_key='previous-poll',run_after=now()-interval '1 minute' WHERE kind='telegram_poll'`
    )
    await enqueueTelegramUpdate(context, connection.id, update)
    const inbound = await claimNextChannelJob(database)
    expect(inbound?.kind).toBe("process_inbound")
    if (!inbound) throw new Error("Expected the visitor message job.")
    await completeChannelJob(database, inbound)
    expect(await enqueueTelegramPollingJobs(database)).toBe(0)
    const poll = await claimNextChannelJob(database)
    expect(poll?.kind).toBe("telegram_poll")
    if (!poll) throw new Error("Expected the background poll.")
    expect(await enqueueTelegramPollingJobs(database)).toBe(0)
    await completeChannelJob(database, poll)
    expect(await enqueueTelegramPollingJobs(database)).toBe(1)
  }, 30_000)

  test("validates local Telegram setup before networking and reconnects after a safe network error", async () => {
    const { context, connection } = await fixture()
    const originalFetch = globalThis.fetch
    const originalUrl = process.env.DATOOL_PUBLIC_URL
    let requests = 0
    try {
      globalThis.fetch = (async () => {
        requests++
        throw new TypeError(`Network failed for bot${token}`)
      }) as typeof fetch
      for (const url of [
        "http://localhost:3000",
        "https://localhost:3000",
        "https://127.0.0.1",
      ]) {
        process.env.DATOOL_PUBLIC_URL = url
        await assert.rejects(
          registerTelegramConnection(context, connection.id, {
            mode: "webhook",
          }),
          { code: "VALIDATION_ERROR", message: /Polling worker/ }
        )
      }
      expect(requests).toBe(0)

      await assert.rejects(
        registerTelegramConnection(context, connection.id, { mode: "polling" }),
        { status: 502, details: { reason: "NETWORK_ERROR" } }
      )
      const failed = (await getChannelConnection(context, connection.id))
        .connection
      expect(failed.status).toBe("error")
      expect(failed.config.mode).toBe("polling")
      expect(failed.lastError).toContain("reach")
      expect(failed.lastError).not.toContain(token)

      const methods: string[] = []
      globalThis.fetch = (async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!
        methods.push(method)
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: 123456,
              is_bot: true,
              first_name: "Support",
              username: "support_bot",
            },
          })
        expect(method).toBe("deleteWebhook")
        expect(
          JSON.parse(String(init?.body)).drop_pending_updates === true
        ).toBe(false)
        return Response.json({ ok: true, result: true })
      }) as typeof fetch
      const connected = await registerTelegramConnection(
        context,
        connection.id,
        { mode: "polling" }
      )
      expect(connected.status).toBe("connected")
      expect(connected.lastError).toBeNull()
      expect(connected.config).toMatchObject({
        mode: "polling",
        botUsername: "support_bot",
      })
      expect(methods).toEqual(["getMe", "deleteWebhook"])
    } finally {
      globalThis.fetch = originalFetch
      if (originalUrl === undefined) delete process.env.DATOOL_PUBLIC_URL
      else process.env.DATOOL_PUBLIC_URL = originalUrl
    }
  })

  test("edits channel settings without changing credentials or crossing projects", async () => {
    const { context, connection } = await fixture()
    const renamed = await updateChannelConnection(context, {
      connectionId: connection.id,
      label: "Renamed bot",
    })
    expect(renamed.label).toBe("Renamed bot")
    expect(renamed.status).toBe("connected")
    expect("credentials" in renamed).toBe(false)
    const privateConnection = await getChannelConnection(
      context,
      connection.id,
      { includeSecret: true }
    )
    expect(privateConnection.credentials?.token).toBe(token)
    expect(privateConnection.connection.config.mode).toBe("webhook")
    await assert.rejects(
      updateChannelConnection(context, {
        connectionId: connection.id,
        originAllowlist: ["https://customer.example"],
      }),
      /only to website/
    )
    await assert.rejects(
      updateChannelConnection(
        { ...context, projectId: "unrelated-project" },
        { connectionId: connection.id, label: "Not allowed" }
      ),
      /not found/
    )
    expect(
      (await getChannelConnection(context, connection.id)).connection.label
    ).toBe("Renamed bot")

    const web = await createChannelConnection(context, {
      agentId: connection.agentId,
      channel: "web",
      label: "Website",
      config: {
        originAllowlist: ["https://old.example"],
        publicAdmission: { maxSessionsPerHour: 20 },
      },
    })
    const updated = await updateChannelConnection(context, {
      connectionId: web.id,
      label: "Customer site",
      originAllowlist: [
        "https://customer.example/",
        "https://customer.example",
      ],
    })
    await updateChannelStatus(context, web.id, "connected")
    await updateChannelConnection(context, {
      connectionId: web.id,
      bubble: { theme: "dark" },
    })
    const inherited = await getPublicChatAppearance(
      context,
      web.id,
      "https://customer.example"
    )
    expect(inherited.appearance).toMatchObject({
      displayName: "Inherited support",
      welcomeMessage: "Hello from the agent",
      theme: "dark",
    })
    const bubble = {
      layout: "help_page" as const,
      helpPage: {
        pageTitle: "Customer help center",
        description: "Answers and resources for our customers",
        faviconUrl: "https://customer.example/favicon.png",
        logoUrl: null,
        heroImageUrl: "https://customer.example/hero.png",
        showSidebar: true,
        allowThemeSwitch: true,
        fieldGlow: false,
        links: [
          {
            id: "docs",
            label: "Documentation",
            url: "https://customer.example/docs",
            description: "Read the guides",
            placement: "card" as const,
          },
        ],
      },
      displayName: "Website helper",
      welcomeMessage: "Welcome to our store",
      theme: "dark" as const,
      position: "left" as const,
      primaryColor: "#e63e1f",
      radius: "small" as const,
      fontSize: 18 as const,
      showBranding: false,
      launcherIcon: "custom" as const,
      launcherIconUrl: "https://customer.example/icon.png",
      launcherColor: "#5648ff",
      localization: {
        source: "fixed" as const,
        defaultLanguage: "pt-BR" as const,
        languages: ["pt-BR" as const],
        translations: { "pt-BR": { welcomeMessage: "Olá!" } },
      },
    }
    await updateChannelConnection(context, { connectionId: web.id, bubble })
    await updateChannelStatus(context, web.id, "connected")
    const display = await getPublicChatAppearance(
      context,
      web.id,
      "https://customer.example"
    )
    expect(display.appearance).toMatchObject(bubble)
    expect("instructions" in display.appearance).toBe(false)
    await updateChannelConnection(context, {
      connectionId: web.id,
      bubble: { offsetX: 32 },
    })
    expect(
      (
        await getPublicChatAppearance(
          context,
          web.id,
          "https://customer.example"
        )
      ).appearance
    ).toMatchObject({ ...bubble, offsetX: 32 })
    const session = await createPublicSession(context, web.id, {
      origin: "https://customer.example",
    })
    expect(session.appearance).toMatchObject(bubble)
    await assert.rejects(
      updateChannelConnection(context, {
        connectionId: web.id,
        bubble: {
          helpPage: {
            ...bubble.helpPage,
            links: [
              { ...bubble.helpPage.links[0]!, url: "javascript:alert(1)" },
            ],
          },
        },
      }),
      /HTTP/
    )
    expect(
      (
        await getPublicChatAppearance(
          context,
          web.id,
          "https://customer.example"
        )
      ).appearance.helpPage
    ).toEqual(bubble.helpPage)
    await assert.rejects(
      getPublicChatAppearance(context, web.id, "https://denied.example"),
      /not enabled/
    )
    await updateChannelStatus(context, web.id, "paused")
    await assert.rejects(
      getPublicChatAppearance(context, web.id, "https://customer.example"),
      /not connected/
    )
    await assert.rejects(
      updateChannelConnection(context, {
        connectionId: web.id,
        bubble: { primaryColor: "url(https://example.com)" },
      }),
      /Invalid/
    )
    await assert.rejects(
      updateChannelConnection(context, {
        connectionId: web.id,
        bubble: { launcherIconUrl: "javascript:alert(1)" },
      }),
      /HTTP/
    )
    expect(updated.config.originAllowlist).toEqual(["https://customer.example"])
    expect(updated.config.publicAdmission).toEqual(web.config.publicAdmission)
    expect(assertPublicOrigin(updated, "https://customer.example")).toBe(
      "https://customer.example"
    )
    expect(() => assertPublicOrigin(updated, "https://old.example")).toThrow(
      "not enabled"
    )
    await assert.rejects(
      updateChannelConnection(context, {
        connectionId: web.id,
        originAllowlist: ["https://customer.example/path"],
      }),
      /without a path/
    )
    expect(
      (await getChannelConnection(context, web.id)).connection.config
        .originAllowlist
    ).toEqual(["https://customer.example"])
  })

  test("deduplicates a Telegram webhook, processes it, and delivers the reply", async () => {
    const { database, context, connection } = await fixture()
    const member = await database.execute<{ user_id: string }>(
      sql`select m."userId" as user_id from member m join project p on p.organization_id=m."organizationId" where p.id=${context.projectId} limit 1`
    )
    const team = await createTeam(context, { name: "Support" })
    await setTeamMember(context, {
      teamId: team.id,
      userId: member.rows[0]!.user_id,
      availability: "online",
      maxConcurrent: 10,
    })
    await createRoutingRule(context, {
      name: "Telegram support",
      conditions: { channel: "telegram" },
      teamId: team.id,
    })
    const first = await enqueueTelegramUpdate(context, connection.id, update)
    const duplicate = await enqueueTelegramUpdate(
      context,
      connection.id,
      update
    )
    expect(first.accepted).toBe(true)
    expect(duplicate.deduplicated).toBe(true)
    if (!("conversationId" in first))
      throw new Error("Inbound Telegram update was not admitted.")
    const conversationId = first.conversationId

    const counts = await database.execute<{
      messages: string
      jobs: string
    }>(sql`
      SELECT
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId}) AS messages,
        (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId}) AS jobs
    `)
    expect(counts.rows[0]).toEqual({ messages: "1", jobs: "1" })
    const ticket = await database.execute<{
      team_id: string | null
      assignee_user_id: string | null
    }>(
      sql`select team_id,assignee_user_id from build_inbox_tickets where project_id=${context.projectId} and conversation_id=${conversationId}`
    )
    expect(ticket.rows[0]).toEqual({
      team_id: team.id,
      assignee_user_id: member.rows[0]!.user_id,
    })

    const inboundJob = await claimNextChannelJob(database)
    expect(inboundJob?.kind).toBe("process_inbound")
    if (!inboundJob) return

    const originalFetch = globalThis.fetch
    const requests: Array<{ method: string; body: Record<string, unknown> }> =
      []
    globalThis.fetch = (async (_input, init) => {
      requests.push({
        method: String(init?.method),
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {},
      })
      return Response.json({
        ok: true,
        result: { message_id: 12, chat: { id: 9001 } },
      })
    }) as typeof fetch
    try {
      const inboundResult = await processChannelJob(
        inboundJob,
        async () => ({
          messages: [{ text: "I found your order." }],
        }),
        database
      )
      expect(inboundResult).toEqual({ outputMessages: 1 })
      await completeChannelJob(database, inboundJob)

      const outboundJob = await claimNextChannelJob(database)
      expect(outboundJob?.kind).toBe("deliver_outbound")
      if (!outboundJob) return
      const outboundResult = await processChannelJob(
        outboundJob,
        async () => ({ messages: [] }),
        database
      )
      expect(outboundResult).toEqual({ sentMessageIds: ["12"] })
      await completeChannelJob(database, outboundJob)

      const statuses = await database.execute<{
        inbound: string
        outbound: string
        jobs: string
      }>(sql`
        SELECT
          (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND direction = 'inbound') AS inbound,
          (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND direction = 'outbound') AS outbound,
          (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId} AND status = 'succeeded') AS jobs
      `)
      expect(statuses.rows[0]).toEqual({
        inbound: "delivered",
        outbound: "sent",
        jobs: "2",
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body.text).toBe("I found your order.")
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  test("deduplicates a channel worker agent failure fallback per inbound job", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, update)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const job = await claimNextChannelJob(database)
    if (!job) throw new Error("Inbound channel job was not claimed.")

    const runner = async () => {
      const error = new Error("provider failed")
      Object.assign(error, { code: "MODEL_REQUEST_FAILED" })
      throw error
    }
    await assert.rejects(processChannelJob(job, runner, database))
    await assert.rejects(processChannelJob(job, runner, database))

    const events = await database.execute<{
      count: string
      payload: Record<string, unknown>
    }>(sql`
      SELECT count(*)::text AS count,
             (array_agg(payload_json ORDER BY created_at DESC))[1] AS payload
      FROM build_operation_events
      WHERE project_id = ${context.projectId}
        AND event_type = 'agent_failed'
        AND conversation_id = ${accepted.conversationId}
    `)
    expect(events.rows[0]?.count).toBe("1")
    expect(events.rows[0]?.payload).toMatchObject({ jobId: job.id })
  }, 30_000)

  test("rejects forged Telegram webhook secrets without exposing the stored secret", async () => {
    const { database, context, connection } = await fixture()
    const secret = "s".repeat(43)
    await database.execute(sql`
      UPDATE build_channel_connection
      SET encrypted_webhook_secret = ${encryptChannelCredentials({ value: secret }, context.projectId, connection.id)}, status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${connection.id}::uuid
    `)
    expect(
      await verifyTelegramWebhookSecret(context, connection.id, "forged")
    ).toBe(false)
    expect(
      await verifyTelegramWebhookSecret(context, connection.id, secret)
    ).toBe(true)
  }, 30_000)

  test("uses the same durable runtime path for a signed public web session", async () => {
    const { database, context } = await fixture()
    const web = await createChannelConnection(context, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentId: "agent-telegram",
      channel: "web",
      label: "Website chat",
      config: { originAllowlist: ["https://example.test"] },
    })
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const session = await createPublicSession(context, web.id, {
      origin: "https://example.test",
    })
    const accepted = await enqueuePublicMessage(
      context,
      web.id,
      session.conversationId,
      session.visitorToken,
      {
        text: "Can I change my delivery address?",
        origin: "https://example.test",
      }
    )
    expect(accepted.accepted).toBe(true)

    const waiting = await readPublicConversation(
      context,
      web.id,
      session.conversationId,
      session.visitorToken,
      "https://example.test"
    )
    expect(waiting[0]?.pendingReply).toBe(true)

    const inboundJob = await claimNextChannelJob(database)
    expect(inboundJob?.kind).toBe("process_inbound")
    if (!inboundJob) return
    let responseTraceId: string | null = null
    await processChannelJob(
      inboundJob,
      async (input) => {
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
              generateText: (async () => ({
                text: "Yes, before dispatch.",
                usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
              })) as unknown as NonNullable<
                RuntimeDependencies["generateText"]
              >,
            },
          }
        )
        responseTraceId = result.traceId
        return {
          ownerFence: result.turn.ownerFence,
          messages: [
            {
              text: result.text,
              metadata: {
                widgetId: "address-help",
                completedContinuationId: "submitted-address-form",
                secret: "must not be public",
              },
            },
          ],
        }
      },
      database
    )
    await completeChannelJob(database, inboundJob)
    const outboundJob = await claimNextChannelJob(database)
    expect(outboundJob?.kind).toBe("deliver_outbound")
    if (!outboundJob) return
    await processChannelJob(
      outboundJob,
      async () => ({ messages: [] }),
      database
    )
    await completeChannelJob(database, outboundJob)

    const messages = await readPublicConversation(
      context,
      web.id,
      session.conversationId,
      session.visitorToken,
      "https://example.test"
    )
    expect(messages.map((message) => message.text)).toEqual([
      "Can I change my delivery address?",
      "Yes, before dispatch.",
    ])
    expect(messages[1]?.metadata).toEqual({
      widgetId: "address-help",
      completedContinuationId: "submitted-address-form",
    })
    expect(messages.some((message) => message.pendingReply)).toBe(false)
    const replyId = messages[1]!.id
    const rating = await recordPublicFeedback(
      context,
      web.id,
      session.conversationId,
      session.visitorToken,
      {
        messageId: replyId,
        question: "Can I change my delivery address?",
        sentiment: "positive",
        origin: "https://example.test",
      }
    )
    const recorded = await database.execute<{
      payload_json: Record<string, unknown>
    }>(sql`
      SELECT payload_json FROM build_operation_events WHERE project_id = ${context.projectId} AND id = ${rating.id}
    `)
    expect(recorded.rows[0]?.payload_json).toMatchObject({
      messageId: replyId,
      sentiment: "positive",
    })
    expect(responseTraceId).toBeTruthy()
    const ratedTrace = await runTracerEffect(
      new TracerService(database).getTrace(responseTraceId!)
    )
    expect(ratedTrace.scores).toHaveLength(1)
    expect(ratedTrace.scores[0]).toMatchObject({
      name: "Customer feedback",
      valueLabel: "Helpful",
      metadata: { channelMessageId: replyId },
    })
    const otherVisitor = await createPublicSession(context, web.id, {
      origin: "https://example.test",
    })
    await assert.rejects(
      recordPublicFeedback(
        context,
        web.id,
        otherVisitor.conversationId,
        otherVisitor.visitorToken,
        {
          messageId: replyId,
          question: "Another visitor's answer",
          sentiment: "negative",
          origin: "https://example.test",
        }
      ),
      /Message is not available/
    )
    await assert.rejects(
      recordPublicFeedback(
        context,
        web.id,
        session.conversationId,
        session.visitorToken,
        {
          messageId: messages[0]!.id,
          question: "A visitor cannot rate an inbound message",
          sentiment: "negative",
          origin: "https://example.test",
        }
      ),
      /Message is not available/
    )
  }, 30_000)

  test("keeps visitor history and reopens only threads owned by that visitor and channel", async () => {
    const { context } = await fixture()
    const web = await createChannelConnection(context, {
      agentId: "agent-telegram",
      channel: "web",
      label: "Help page",
      config: { bubble: { layout: "help_page" } },
    })
    await updateChannelStatus(context, web.id, "connected")
    const first = await createPublicSession(context, web.id)
    await enqueuePublicMessage(
      context,
      web.id,
      first.conversationId,
      first.visitorToken,
      { text: "Help with my order" }
    )
    const second = await createPublicSession(context, web.id, {
      visitorToken: first.visitorToken,
    })
    expect(second.visitorId).toBe(first.visitorId)
    await enqueuePublicMessage(
      context,
      web.id,
      second.conversationId,
      second.visitorToken,
      { text: "Shipping question" }
    )
    await resetPublicConversation(
      context,
      web.id,
      first.conversationId,
      first.visitorToken
    )
    const history = await listPublicConversations(
      context,
      web.id,
      second.visitorToken
    )
    expect(history.map((thread) => thread.title)).toEqual([
      "Shipping question",
      "Help with my order",
    ])
    const resumed = await createPublicSession(context, web.id, {
      visitorToken: second.visitorToken,
      conversationId: first.conversationId,
    })
    expect(resumed.conversationId).toBe(first.conversationId)
    expect(
      (
        await readPublicConversation(
          context,
          web.id,
          resumed.conversationId,
          resumed.visitorToken
        )
      )[0]?.text
    ).toBe("Help with my order")
    expect(
      (
        await enqueuePublicMessage(
          context,
          web.id,
          resumed.conversationId,
          resumed.visitorToken,
          { text: "Continue this thread" }
        )
      ).accepted
    ).toBe(true)
    const stranger = await createPublicSession(context, web.id)
    expect(
      await listPublicConversations(context, web.id, stranger.visitorToken)
    ).toEqual([])
    await assert.rejects(
      createPublicSession(context, web.id, {
        visitorToken: stranger.visitorToken,
        conversationId: first.conversationId,
      }),
      /not available/
    )
    await assert.rejects(
      createPublicSession(context, web.id, {
        conversationId: first.conversationId,
      }),
      /Invalid visitor/
    )
    await assert.rejects(
      listPublicConversations(context, web.id, `${first.visitorToken}forged`),
      /Invalid visitor/
    )
    const other = await createChannelConnection(context, {
      agentId: "agent-telegram",
      channel: "web",
      label: "Another page",
    })
    await updateChannelStatus(context, other.id, "connected")
    await assert.rejects(
      listPublicConversations(context, other.id, first.visitorToken),
      /connection does not match/
    )
    await assert.rejects(
      createPublicSession(context, other.id, {
        visitorToken: first.visitorToken,
        conversationId: first.conversationId,
      }),
      /connection does not match/
    )
  })

  test("queues an authenticated operator result once through the signed channel outbox", async () => {
    const { database, context } = await fixture()
    const web = await createChannelConnection(context, {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentId: "agent-telegram",
      channel: "web",
      label: "Operator result website",
      config: { originAllowlist: ["https://example.test"] },
    })
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const session = await createPublicSession(context, web.id, {
      origin: "https://example.test",
    })
    const conversation = await new ConversationService(context).require(
      session.conversationId
    )
    const result = {
      conversation,
      turn: { snapshot: { agentRevision: 4 } },
      text: "Approved result",
      continuations: [],
    } as never
    const first = await enqueueAgentTurnResult(
      context,
      result,
      "operator:approval-1"
    )
    const retry = await enqueueAgentTurnResult(
      context,
      result,
      "operator:approval-1"
    )
    expect(first.queued).toBe(true)
    expect(retry.deduplicated).toBe(true)
    const rows = await database.execute<{ count: string; text: string }>(sql`
      SELECT count(*)::text AS count,
             max(content_json->>'text') AS text
      FROM build_channel_message
      WHERE project_id = ${context.projectId}
        AND conversation_id = ${session.conversationId}
        AND direction = 'outbound'
    `)
    expect(rows.rows[0]).toEqual({ count: "1", text: "Approved result" })
  }, 30_000)

  test("persists public inbound messages during human takeover without dispatching the agent", async () => {
    const { database, context } = await fixture()
    const web = await createChannelConnection(context, {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      agentId: "agent-telegram",
      channel: "web",
      label: "Human takeover website",
      config: { originAllowlist: ["https://example.test"] },
    })
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const session = await createPublicSession(context, web.id, {
      origin: "https://example.test",
    })
    await database.execute(sql`
      UPDATE build_conversations
      SET owner_type = 'human', owner_id = 'human-1', status = 'handed_off'
      WHERE project_id = ${context.projectId} AND id = ${session.conversationId}
    `)

    const accepted = await enqueuePublicMessage(
      context,
      web.id,
      session.conversationId,
      session.visitorToken,
      {
        text: "I still need help from the support team.",
        origin: "https://example.test",
      }
    )
    expect(accepted.accepted).toBe(true)
    expect("humanOwned" in accepted && accepted.humanOwned).toBe(true)

    const before = await database.execute<{
      messages: string
      outboundJobs: string
    }>(sql`
      SELECT
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${session.conversationId}) AS messages,
        (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId} AND kind = 'deliver_outbound') AS "outboundJobs"
    `)
    expect(before.rows[0]).toEqual({ messages: "1", outboundJobs: "0" })

    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return
    let runnerCalls = 0
    const result = await processChannelJob(
      job,
      async () => {
        runnerCalls += 1
        return { messages: [] }
      },
      database
    )
    await completeChannelJob(database, job)
    expect(result).toEqual({ ignored: true, reason: "human_ownership" })
    expect(runnerCalls).toBe(0)

    const after = await database.execute<{
      message_status: string
      job_status: string
      outboundJobs: string
    }>(sql`
      SELECT
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${session.conversationId}) AS message_status,
        (SELECT status FROM build_channel_job WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid) AS job_status,
        (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId} AND kind = 'deliver_outbound') AS "outboundJobs"
    `)
    expect(after.rows[0]).toEqual({
      message_status: "ignored",
      job_status: "succeeded",
      outboundJobs: "0",
    })
  }, 30_000)

  test("persists Telegram inbound messages during human takeover without dispatching the agent", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 84,
    })
    expect(accepted.accepted).toBe(true)
    const initialJob = await claimNextChannelJob(database)
    expect(initialJob?.kind).toBe("process_inbound")
    if (!initialJob) return
    await processChannelJob(
      initialJob,
      async () => ({ messages: [] }),
      database
    )
    await completeChannelJob(database, initialJob)
    const conversation = await database.execute<{ id: string }>(sql`
      SELECT id
      FROM build_conversations
      WHERE project_id = ${context.projectId} AND channel = 'telegram'
      LIMIT 1
    `)
    const conversationId = conversation.rows[0]?.id
    if (!conversationId)
      throw new Error("Telegram conversation was not created.")
    await database.execute(sql`
      UPDATE build_conversations
      SET owner_type = 'human', owner_id = 'human-1', status = 'handed_off'
      WHERE project_id = ${context.projectId} AND id = ${conversationId}
    `)

    const followUp = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 85,
      message: { ...update.message, message_id: 12, text: "Another question" },
    })
    expect(followUp.accepted).toBe(true)
    expect("humanOwned" in followUp && followUp.humanOwned).toBe(true)

    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return
    let runnerCalls = 0
    const result = await processChannelJob(
      job,
      async () => {
        runnerCalls += 1
        return { messages: [] }
      },
      database
    )
    await completeChannelJob(database, job)
    expect(result).toEqual({ ignored: true, reason: "human_ownership" })
    expect(runnerCalls).toBe(0)

    const state = await database.execute<{
      message_status: string
      job_status: string
      outboundJobs: string
    }>(sql`
      SELECT
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${conversationId} AND provider_message_id = '12') AS message_status,
        (SELECT status FROM build_channel_job WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid) AS job_status,
        (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId} AND kind = 'deliver_outbound') AS "outboundJobs"
    `)
    expect(state.rows[0]).toEqual({
      message_status: "ignored",
      job_status: "succeeded",
      outboundJobs: "0",
    })
  }, 30_000)

  test("drops an agent response when human takeover wins during execution", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 86,
    })
    expect(accepted.accepted).toBe(true)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return
    let runnerCalls = 0
    const result = await processChannelJob(
      job,
      async (input) => {
        runnerCalls += 1
        await database.execute(sql`
        UPDATE build_conversations
        SET owner_type = 'human', owner_id = 'human-2', status = 'handed_off'
        WHERE project_id = ${context.projectId} AND id = ${input.conversationId}
      `)
        return { messages: [{ text: "This reply must not be sent." }] }
      },
      database
    )
    await completeChannelJob(database, job)
    expect(result).toEqual({ ignored: true, reason: "human_ownership" })
    expect(runnerCalls).toBe(1)

    const state = await database.execute<{
      message_status: string
      job_status: string
      outboundJobs: string
    }>(sql`
      SELECT
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND id = ${job.messageId}) AS message_status,
        (SELECT status FROM build_channel_job WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid) AS job_status,
        (SELECT count(*)::text FROM build_channel_job WHERE project_id = ${context.projectId} AND kind = 'deliver_outbound') AS "outboundJobs"
    `)
    expect(state.rows[0]).toEqual({
      message_status: "ignored",
      job_status: "succeeded",
      outboundJobs: "0",
    })
  }, 30_000)

  test("delivers a runtime-owned handoff using the committed human fence", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 87,
    })
    expect(accepted.accepted).toBe(true)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return

    const result = await processChannelJob(
      job,
      async (input) => {
        const service = new ConversationService(context)
        const current = await service.require(input.conversationId)
        const handedOff = await service.claim(
          input.conversationId,
          { type: "human", id: "team-support", reason: "Model handoff" },
          {
            expectedOwnerFence: current.ownerFence,
            expectedOwnerType: "ai",
          }
        )
        return {
          ownerFence: handedOff.ownerFence,
          ownerType: handedOff.ownerType,
          ownership: "human" as const,
          messages: [{ text: "A human teammate will help next." }],
        }
      },
      database
    )
    await completeChannelJob(database, job)
    expect(result).toEqual({ outputMessages: 1 })

    const state = await database.execute<{
      owner_type: string
      owner_fence: string
      inbound_status: string
      outbound_count: string
      outbound_text: string
      handoff_count: string
    }>(sql`
      SELECT
        (SELECT owner_type FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_type,
        (SELECT owner_fence::text FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_fence,
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND id = ${job.messageId}) AS inbound_status,
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND direction = 'outbound') AS outbound_count,
        (SELECT max(content_json->>'text') FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND direction = 'outbound') AS outbound_text,
        (SELECT count(*)::text FROM build_operation_events WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND event_type = 'handoff') AS handoff_count
    `)
    expect(state.rows[0]).toEqual({
      owner_type: "human",
      owner_fence: "1",
      inbound_status: "delivered",
      outbound_count: "1",
      outbound_text: "A human teammate will help next.",
      handoff_count: "1",
    })
  }, 30_000)

  test("repairs a committed runtime handoff after a worker crash before enqueue", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 89,
    })
    expect(accepted.accepted).toBe(true)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return

    await assert.rejects(
      processChannelJob(
        job,
        async () => {
          const service = new ConversationService(context)
          const admission = await service.startTurn(accepted.conversationId, {
            requestKey: `channel:${job.id}`,
            input: "Where is my order?",
            metadata: {},
            snapshot: {
              agentId: "agent-telegram",
              agentRevision: 1,
              channel: "telegram",
            },
          })
          const handoff = {
            type: "handoff" as const,
            actionId: "handoff_support",
            continuationId: "handoff-continuation-89",
            teamId: "team-support",
            message: "A human teammate will help next.",
          }
          const toolCallId = "handoff-tool-call-89"
          await service.recordToolCallStart({
            conversationId: accepted.conversationId,
            turnId: admission.turn.id,
            toolCallId,
            actionId: handoff.actionId,
            args: {},
            ownerFence: admission.turn.ownerFence,
          })
          await service.recordToolCallFinish({
            conversationId: accepted.conversationId,
            turnId: admission.turn.id,
            toolCallId,
            status: "completed",
            output: handoff,
            continuation: handoff,
            ownerFence: admission.turn.ownerFence,
          })
          const message = await service.appendMessage(
            accepted.conversationId,
            {
              role: "assistant",
              content: "A human teammate will help next.",
              turnId: admission.turn.id,
              status: "completed",
              metadata: {},
            },
            { ownerFence: admission.turn.ownerFence }
          )
          await service.finishTurn({
            turnId: admission.turn.id,
            ownerFence: admission.turn.ownerFence,
            status: "awaiting_client",
            outputMessageId: message.id,
            usage: {},
          })
          await service.claim(
            accepted.conversationId,
            {
              type: "human",
              id: "team-support",
              reason: "Agent handoff action",
            },
            {
              expectedOwnerFence: admission.turn.ownerFence,
              expectedOwnerType: "ai",
              handoffTurnId: admission.turn.id,
            }
          )
          throw new Error("simulated worker crash after handoff")
        },
        database
      )
    )
    await failChannelJob(database, job, {
      code: "NETWORK_ERROR",
      message: "simulated worker crash",
    })
    await database.execute(sql`
      UPDATE build_channel_job
      SET run_after = now()
      WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid
    `)
    const retry = await claimNextChannelJob(database)
    expect(retry?.kind).toBe("process_inbound")
    if (!retry) return
    let rerun = false
    const repaired = await processChannelJob(
      retry,
      async () => {
        rerun = true
        return { messages: [{ text: "must not run again" }] }
      },
      database
    )
    await completeChannelJob(database, retry)
    expect(repaired).toEqual({ outputMessages: 1 })
    expect(rerun).toBe(false)

    const state = await database.execute<{
      inbound_status: string
      outbound_count: string
      outbound_text: string
      owner_type: string
      owner_fence: string
    }>(sql`
      SELECT
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND id = ${retry.messageId}) AS inbound_status,
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND direction = 'outbound') AS outbound_count,
        (SELECT max(content_json->>'text') FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND direction = 'outbound') AS outbound_text,
        (SELECT owner_type FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_type,
        (SELECT owner_fence::text FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_fence
    `)
    expect(state.rows[0]).toEqual({
      inbound_status: "delivered",
      outbound_count: "1",
      outbound_text: "A human teammate will help next.",
      owner_type: "human",
      owner_fence: "2",
    })
  }, 30_000)

  test("replays a handoff from its persisted fence instead of the current epoch", async () => {
    const { context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 90,
    })
    expect(accepted.accepted).toBe(true)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const service = new ConversationService(context)
    const admission = await service.startTurn(accepted.conversationId, {
      requestKey: "replayed-handoff-90",
      input: "Where is my order?",
      metadata: {},
      snapshot: {
        agentId: "agent-telegram",
        agentRevision: 1,
        channel: "telegram",
      },
    })
    const handoff = {
      type: "handoff" as const,
      actionId: "handoff_support",
      continuationId: "handoff-continuation-90",
      teamId: "team-support",
      message: "A human teammate will help next.",
    }
    await service.recordToolCallStart({
      conversationId: accepted.conversationId,
      turnId: admission.turn.id,
      toolCallId: "handoff-tool-call-90",
      actionId: handoff.actionId,
      args: {},
      ownerFence: admission.turn.ownerFence,
    })
    await service.recordToolCallFinish({
      conversationId: accepted.conversationId,
      turnId: admission.turn.id,
      toolCallId: "handoff-tool-call-90",
      status: "completed",
      output: handoff,
      continuation: handoff,
      ownerFence: admission.turn.ownerFence,
    })
    const output = await service.appendMessage(
      accepted.conversationId,
      {
        role: "assistant",
        content: handoff.message,
        turnId: admission.turn.id,
        status: "completed",
        metadata: {},
      },
      { ownerFence: admission.turn.ownerFence }
    )
    await service.finishTurn({
      turnId: admission.turn.id,
      ownerFence: admission.turn.ownerFence,
      status: "awaiting_client",
      outputMessageId: output.id,
      usage: {},
    })
    await service.claim(
      accepted.conversationId,
      { type: "human", id: "team-support", reason: "Agent handoff action" },
      {
        expectedOwnerFence: admission.turn.ownerFence,
        expectedOwnerType: "ai",
        handoffTurnId: admission.turn.id,
      }
    )
    const replayedTurn = await service.getTurn(admission.turn.id)
    const replayedConversation = await service.require(accepted.conversationId)
    if (!replayedTurn) throw new Error("Handoff turn was not persisted.")
    const replayed = await enqueueAgentTurnResult(
      context,
      {
        status: "replayed",
        conversation: replayedConversation,
        turn: replayedTurn,
        message: output,
        text: handoff.message,
        continuations: [handoff],
        toolCalls: [],
        traceId: null,
        usage: {},
        replayed: true,
      },
      "replayed-handoff-90"
    )
    expect(replayed.queued).toBe(true)

    await service.claim(accepted.conversationId, {
      type: "human",
      id: "another-human",
      reason: "Operator reassignment",
    })
    const stale = await enqueueAgentTurnResult(
      context,
      {
        status: "replayed",
        conversation: replayedConversation,
        turn: replayedTurn,
        message: output,
        text: handoff.message,
        continuations: [handoff],
        toolCalls: [],
        traceId: null,
        usage: {},
        replayed: true,
      },
      "replayed-handoff-90-stale"
    )
    expect(stale).toEqual({
      queued: false,
      deduplicated: false,
      reason: "ownership_changed",
    })
  }, 30_000)

  test("does not let a forged human handoff marker bypass the AI fence", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 88,
    })
    expect(accepted.accepted).toBe(true)
    if (!("conversationId" in accepted))
      throw new Error("Inbound Telegram update was not admitted.")
    const job = await claimNextChannelJob(database)
    expect(job?.kind).toBe("process_inbound")
    if (!job) return

    const result = await processChannelJob(
      job,
      async (input) => {
        const current = await new ConversationService(context).require(
          input.conversationId
        )
        return {
          ownerFence: current.ownerFence + 1,
          ownerType: "human" as const,
          ownership: "human" as const,
          messages: [{ text: "This marker is not an ownership claim." }],
        }
      },
      database
    )
    await completeChannelJob(database, job)
    expect(result).toEqual({ ignored: true, reason: "human_ownership" })

    const state = await database.execute<{
      owner_type: string
      owner_fence: string
      inbound_status: string
      outbound_count: string
    }>(sql`
      SELECT
        (SELECT owner_type FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_type,
        (SELECT owner_fence::text FROM build_conversations WHERE project_id = ${context.projectId} AND id = ${accepted.conversationId}) AS owner_fence,
        (SELECT status FROM build_channel_message WHERE project_id = ${context.projectId} AND id = ${job.messageId}) AS inbound_status,
        (SELECT count(*)::text FROM build_channel_message WHERE project_id = ${context.projectId} AND conversation_id = ${accepted.conversationId} AND direction = 'outbound') AS outbound_count
    `)
    expect(state.rows[0]).toEqual({
      owner_type: "ai",
      owner_fence: "0",
      inbound_status: "ignored",
      outbound_count: "0",
    })
  }, 30_000)

  test("requires an active public deployment and prevents cross-agent or cross-channel sends", async () => {
    const { database, context, connection } = await fixture()
    const web = await createChannelConnection(context, {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentId: "agent-telegram",
      channel: "web",
      label: "Website chat",
      config: { originAllowlist: ["https://example.test"] },
    })
    await assert.rejects(
      createPublicSession(context, web.id, { origin: "https://example.test" }),
      /not connected/i
    )
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const session = await createPublicSession(context, web.id, {
      origin: "https://example.test",
    })
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'paused'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    await assert.rejects(
      enqueuePublicMessage(
        context,
        web.id,
        session.conversationId,
        session.visitorToken,
        {
          text: "This should be rejected while paused.",
          origin: "https://example.test",
        }
      ),
      /not connected/i
    )
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const admitted = await enqueueTelegramUpdate(context, connection.id, update)
    expect(admitted.accepted).toBe(true)
    const conversation = await database.execute<{
      id: string
      external_conversation_id: string
    }>(sql`
      SELECT id, external_conversation_id
      FROM build_conversations
      WHERE project_id = ${context.projectId} AND channel = 'telegram'
      LIMIT 1
    `)
    const telegramConversation = conversation.rows[0]
    if (!telegramConversation)
      throw new Error("Telegram conversation was not created.")
    await assert.rejects(
      enqueueOutboundEnvelope(
        context,
        {
          connectionId: web.id,
          conversationId: telegramConversation.id,
          channel: "web",
          idempotencyKey: "cross-channel-send",
          text: "This must not cross a channel boundary.",
        },
        telegramConversation.external_conversation_id
      ),
      /channel/i
    )
  }, 30_000)

  test("limits anonymous admission across fresh visitor ids and emits the embed policy", async () => {
    const { database, context } = await fixture()
    const web = await createChannelConnection(context, {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agentId: "agent-telegram",
      channel: "web",
      label: "Rate limited website chat",
      config: {
        originAllowlist: ["https://example.test"],
        publicAdmission: { session: { maxRequests: 2, windowSeconds: 60 } },
      },
    })
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'connected'
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    const connected = { ...web, status: "connected" as const }
    expect(publicChatContentSecurityPolicy(connected)).toBe(
      "frame-ancestors 'self' https://example.test"
    )
    const previousBaseUrl = process.env.BETTER_AUTH_URL
    process.env.BETTER_AUTH_URL = "https://app.example.test"
    try {
      expect(assertPublicOrigin(connected, "https://app.example.test")).toBe(
        "https://app.example.test"
      )
      expect(() => assertPublicOrigin(connected, "https://evil.test")).toThrow(
        "not enabled"
      )
    } finally {
      if (previousBaseUrl === undefined) delete process.env.BETTER_AUTH_URL
      else process.env.BETTER_AUTH_URL = previousBaseUrl
    }
    await createPublicSession(context, web.id, {
      origin: "https://example.test",
      clientKey: "ip:192.0.2.10",
    })
    await createPublicSession(context, web.id, {
      origin: "https://example.test",
      clientKey: "ip:192.0.2.10",
    })
    await assert.rejects(
      createPublicSession(context, web.id, {
        origin: "https://example.test",
        clientKey: "ip:192.0.2.10",
      }),
      (error: unknown) => error instanceof PublicAdmissionRateLimitError
    )
    const counts = await database.execute<{
      contacts: string
      conversations: string
    }>(sql`
      SELECT
        (SELECT count(*)::text FROM build_contacts WHERE project_id = ${context.projectId} AND external_id LIKE ${`web:${web.id}:%`}) AS contacts,
        (SELECT count(*)::text FROM build_conversations WHERE project_id = ${context.projectId} AND channel = 'web') AS conversations
    `)
    expect(counts.rows[0]).toEqual({ contacts: "2", conversations: "2" })

    await database.execute(sql`
      UPDATE build_channel_connection
      SET config_json = ${JSON.stringify({ publicAdmission: { session: { maxRequests: 1, windowSeconds: 60 } } })}::jsonb
      WHERE project_id = ${context.projectId} AND id = ${web.id}::uuid
    `)
    await createPublicSession(context, web.id, {
      origin: "https://first-caller.example",
    })
    await assert.rejects(
      createPublicSession(context, web.id, {
        origin: "https://rotated-caller.example",
      }),
      (error: unknown) => error instanceof PublicAdmissionRateLimitError
    )
  }, 30_000)

  test("does not let a stale lease mutate a channel job or its message", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 80,
    })
    expect(accepted.accepted).toBe(true)
    const job = await claimNextChannelJob(database)
    if (!job) throw new Error("Expected a claimed channel job.")
    await database.execute(sql`
      UPDATE build_channel_job
      SET lock_token = gen_random_uuid()
      WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid
    `)
    await failChannelJob(database, job, {
      code: "RATE_LIMITED",
      message: "stale",
    })
    const state = await database.execute<{
      job_status: string
      message_status: string
    }>(sql`
      SELECT j.status AS job_status, m.status AS message_status
      FROM build_channel_job j
      JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
      WHERE j.project_id = ${context.projectId} AND j.id = ${job.id}::uuid
    `)
    expect(state.rows[0]).toEqual({
      job_status: "running",
      message_status: "accepted",
    })
  }, 30_000)

  test("requeues channel jobs when provider retry delays are invalid", async () => {
    const { database, context, connection } = await fixture()
    await enqueueTelegramUpdate(context, connection.id, update)

    for (const [retryAfterSeconds, delaySeconds] of [
      [NaN, 2],
      [Infinity, 4],
      [-1, 8],
    ]) {
      const job = await claimNextChannelJob(database)
      if (!job) throw new Error("Expected a retryable channel job.")
      expect(
        await failChannelJob(database, job, {
          code: "NETWORK_ERROR",
          message: "Connection timed out.",
          retryAfterSeconds,
        })
      ).toEqual({ terminal: false, delaySeconds })
      const state = await database.execute<{
        status: string
        unlocked: boolean
        scheduled: boolean
      }>(sql`
        SELECT status, locked_at IS NULL AND lock_token IS NULL AS unlocked,
               isfinite(run_after) AS scheduled
        FROM build_channel_job
        WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid
      `)
      expect(state.rows[0]).toEqual({
        status: "queued",
        unlocked: true,
        scheduled: true,
      })
      await database.execute(sql`
        UPDATE build_channel_job SET run_after = now()
        WHERE project_id = ${context.projectId} AND id = ${job.id}::uuid
      `)
    }
  }, 30_000)

  test("records retryable and uncertain delivery states behind the lease", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 78,
    })
    expect(accepted.accepted).toBe(true)
    const retryJob = await claimNextChannelJob(database)
    expect(retryJob?.kind).toBe("process_inbound")
    if (!retryJob) return
    const retry = await failChannelJob(database, retryJob, {
      code: "RATE_LIMITED",
      message: "provider body contained a token",
      retryAfterSeconds: 3,
    })
    expect(retry).toEqual({ terminal: false, delaySeconds: 3 })
    const retryState = await database.execute<{
      job_status: string
      message_status: string
      error_message: string
    }>(sql`
      SELECT j.status AS job_status, m.status AS message_status, m.error_message
      FROM build_channel_job j JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
      WHERE j.project_id = ${context.projectId} AND j.id = ${retryJob.id}::uuid
    `)
    expect(retryState.rows[0]).toEqual({
      job_status: "queued",
      message_status: "queued",
      error_message: "Provider rate limit reached.",
    })

    const acceptedUncertain = await enqueueTelegramUpdate(
      context,
      connection.id,
      {
        ...update,
        update_id: 79,
        message: { ...update.message, message_id: 12 },
      }
    )
    expect(acceptedUncertain.accepted).toBe(true)
    const uncertainJob = await claimNextChannelJob(database)
    expect(uncertainJob?.kind).toBe("process_inbound")
    if (!uncertainJob) return
    await failChannelJob(
      database,
      uncertainJob,
      {
        code: "NETWORK_ERROR",
        message: "provider body contained a token",
        uncertain: true,
      },
      1
    )
    const uncertainState = await database.execute<{
      job_status: string
      message_status: string
      error_message: string
    }>(sql`
      SELECT j.status AS job_status, m.status AS message_status, m.error_message
      FROM build_channel_job j JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
      WHERE j.project_id = ${context.projectId} AND j.id = ${uncertainJob.id}::uuid
    `)
    expect(uncertainState.rows[0]).toEqual({
      job_status: "uncertain",
      message_status: "uncertain",
      error_message: "The provider request could not be completed.",
    })
  }, 30_000)

  test("does not call a provider while the claimed connection is paused", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 81,
    })
    expect(accepted.accepted).toBe(true)
    const inboundJob = await claimNextChannelJob(database)
    if (!inboundJob) throw new Error("Expected an inbound channel job.")
    await processChannelJob(
      inboundJob,
      async () => ({ messages: [{ text: "A reply" }] }),
      database
    )
    await completeChannelJob(database, inboundJob)

    const outboundJob = await claimNextChannelJob(database)
    if (!outboundJob) throw new Error("Expected an outbound channel job.")
    await database.execute(sql`
      UPDATE build_channel_connection
      SET status = 'paused'
      WHERE project_id = ${context.projectId} AND id = ${connection.id}::uuid
    `)
    const originalFetch = globalThis.fetch
    let providerCalls = 0
    globalThis.fetch = (async () => {
      providerCalls += 1
      return Response.json({
        ok: true,
        result: { message_id: 99, chat: { id: 9001 } },
      })
    }) as typeof fetch
    try {
      await assert.rejects(
        processChannelJob(
          outboundJob,
          async () => ({ messages: [] }),
          database
        ),
        /not connected/i
      )
      expect(providerCalls).toBe(0)
      const state = await database.execute<{
        job_status: string
        message_status: string
      }>(sql`
        SELECT j.status AS job_status, m.status AS message_status
        FROM build_channel_job j
        JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
        WHERE j.project_id = ${context.projectId} AND j.id = ${outboundJob.id}::uuid
      `)
      expect(state.rows[0]).toEqual({
        job_status: "running",
        message_status: "queued",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  test("retires an expired outbound lease as uncertain instead of replaying the provider write", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 82,
    })
    expect(accepted.accepted).toBe(true)
    const inboundJob = await claimNextChannelJob(database)
    if (!inboundJob) throw new Error("Expected an inbound channel job.")
    await processChannelJob(
      inboundJob,
      async () => ({ messages: [{ text: "A reply" }] }),
      database
    )
    await completeChannelJob(database, inboundJob)

    const outboundJob = await claimNextChannelJob(database)
    if (!outboundJob) throw new Error("Expected an outbound channel job.")
    await database.execute(sql`
      UPDATE build_channel_job
      SET locked_at = now() - interval '6 minutes'
      WHERE project_id = ${context.projectId} AND id = ${outboundJob.id}::uuid
    `)

    expect(await claimNextChannelJob(database)).toBeNull()
    const state = await database.execute<{
      job_status: string
      message_status: string
      error_code: string
      lock_token: string | null
    }>(sql`
      SELECT j.status AS job_status, m.status AS message_status, m.error_code, j.lock_token
      FROM build_channel_job j
      JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
      WHERE j.project_id = ${context.projectId} AND j.id = ${outboundJob.id}::uuid
    `)
    expect(state.rows[0]).toEqual({
      job_status: "uncertain",
      message_status: "uncertain",
      error_code: "CHANNEL_LEASE_LOST",
      lock_token: null,
    })
  }, 30_000)

  test("turns a lease loss after a successful provider write into an uncertain delivery", async () => {
    const { database, context, connection } = await fixture()
    const accepted = await enqueueTelegramUpdate(context, connection.id, {
      ...update,
      update_id: 83,
    })
    expect(accepted.accepted).toBe(true)
    const inboundJob = await claimNextChannelJob(database)
    if (!inboundJob) throw new Error("Expected an inbound channel job.")
    await processChannelJob(
      inboundJob,
      async () => ({ messages: [{ text: "A reply" }] }),
      database
    )
    await completeChannelJob(database, inboundJob)
    const outboundJob = await claimNextChannelJob(database)
    if (!outboundJob) throw new Error("Expected an outbound channel job.")

    const originalFetch = globalThis.fetch
    let providerCalls = 0
    globalThis.fetch = (async () => {
      providerCalls += 1
      await database.execute(sql`
        UPDATE build_channel_job
        SET lock_token = gen_random_uuid()
        WHERE project_id = ${context.projectId} AND id = ${outboundJob.id}::uuid
      `)
      return Response.json({
        ok: true,
        result: { message_id: 100, chat: { id: 9001 } },
      })
    }) as typeof fetch
    try {
      let thrown: unknown
      try {
        await processChannelJob(
          outboundJob,
          async () => ({ messages: [] }),
          database
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({
        code: "CHANNEL_LEASE_LOST",
        uncertain: true,
      })
      expect(providerCalls).toBe(1)
      // The worker no longer owns the lease, so its cleanup cannot mutate the
      // row. The next claim retires the expired outbound write as uncertain.
      await failChannelJob(database, outboundJob, {
        code: "CHANNEL_LEASE_LOST",
        message: "lease lost",
        uncertain: true,
      })
      await database.execute(sql`
        UPDATE build_channel_job
        SET locked_at = now() - interval '6 minutes'
        WHERE project_id = ${context.projectId} AND id = ${outboundJob.id}::uuid
      `)
      expect(await claimNextChannelJob(database)).toBeNull()
      const state = await database.execute<{
        job_status: string
        message_status: string
      }>(sql`
        SELECT j.status AS job_status, m.status AS message_status
        FROM build_channel_job j
        JOIN build_channel_message m ON m.project_id = j.project_id AND m.id = j.message_id
        WHERE j.project_id = ${context.projectId} AND j.id = ${outboundJob.id}::uuid
      `)
      expect(state.rows[0]).toEqual({
        job_status: "uncertain",
        message_status: "uncertain",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)
})

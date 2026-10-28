import { configureBuildTestEnvironment } from "./helpers/build-env"
import { strict as assert } from "node:assert"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"

import {
  createContact,
  importContacts,
  listContactAttributes,
  listContactIdentities,
  setContactAttribute,
  upsertContactIdentity,
} from "@/src/server/build/operations/contacts"
import {
  acknowledgeCampaignDelivery,
  claimCampaignDeliveries,
  createCampaign,
  enqueueDueCampaigns,
  getCampaign,
  listCampaignProjectsWithPendingWork,
  listCampaignDeliveries,
  queueCampaignDeliveries,
  setCampaignStatus,
  snapshotCampaignAudience,
  suppressCampaignContact,
  updateCampaign,
} from "@/src/server/build/operations/campaigns"
import {
  createTicket,
  assignTicket,
  getTicket,
  getConversationOwnership,
  listTicketEvents,
  requestCsat,
  resumeConversation,
  submitCsat,
  takeoverConversation,
} from "@/src/server/build/operations/inbox"
import { sendHumanReply } from "@/src/server/build/operations/inbox"
import { buildOperations } from "@/src/server/build/bootstrap"
import { createConversationService } from "@/src/server/build/conversations"
import { applyMacro, createMacro, createRoutingRule, createTeam, setTeamMember } from "@/src/server/build/operations/teams"
import { processNextCampaignDelivery } from "@/src/server/build/operations/campaigns"
import { createAgent } from "@/src/server/build/agents"
import {
  claimNextChannelJob,
  completeChannelJob,
  createChannelConnection,
  enqueueTelegramUpdate,
  processChannelJob,
} from "@/src/server/build/channels/service"
import {
  getOperationalAnalytics,
  listKnowledgeGapSuggestions,
  recordFeedback,
  refreshKnowledgeGapSuggestions,
} from "@/src/server/build/operations/analytics"
import { getTracerProjectId } from "@/src/server/tracer/db"
import { closeTracerFixture, createTracerFixture } from "./helpers/tracer-fixture"

configureBuildTestEnvironment()

test("Build operations persist contact identity, attributes, and bounded imports", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database), actorId: "user-1" }
  try {
    const contact = await createContact(context, { externalId: "telegram:100", displayName: "Ada", email: "ada@example.com" })
    await upsertContactIdentity(context, { contactId: contact.id, channel: "telegram", identityKey: "100", verified: true })
    await setContactAttribute(context, { contactId: contact.id, key: "plan", value: "pro", source: "manual" })
    const imported = await importContacts(context, { source: "mcp", rows: [{ externalId: "telegram:100", displayName: "Ada Lovelace", metadata: { locale: "en" } }, { externalId: "telegram:200", displayName: "Grace" }] })

    expect(imported.importedCount).toBe(2)
    expect((await listContactIdentities(context, contact.id))[0]?.verified).toBe(true)
    expect((await listContactAttributes(context, contact.id))[0]).toMatchObject({ key: "plan", value: "pro" })

    await createAgent(context, { id: "agent", name: "Agent", slug: "agent", configuration: { model: "openai/gpt-4.1-mini" } })
    const sales = await createChannelConnection(context, { agentId: "agent", channel: "whatsapp", label: "Sales" })
    const support = await createChannelConnection(context, { agentId: "agent", channel: "whatsapp", label: "Support" })
    for (const connection of [sales, support]) {
      await upsertContactIdentity(context, { contactId: contact.id, channel: "whatsapp", identityKey: `${connection.id}:business:customer` })
    }
    // A reference to a connection in another project must not disclose its label.
    const foreignProjectId = crypto.randomUUID()
    await database.execute(sql`insert into project(id,organization_id,name,slug)
      select ${foreignProjectId},organization_id,'Other project',${foreignProjectId} from project where id=${context.projectId}`)
    const foreign = { ...context, projectId: foreignProjectId }
    await createAgent(foreign, { id: "foreign-agent", name: "Agent", slug: "agent", configuration: { model: "openai/gpt-4.1-mini" } })
    const privateConnection = await createChannelConnection(foreign, { agentId: "foreign-agent", channel: "whatsapp", label: "Private connection" })
    const foreignKey = `${privateConnection.id}:business:customer`
    await upsertContactIdentity(context, { contactId: contact.id, channel: "whatsapp", identityKey: foreignKey })

    const identities = await listContactIdentities(context, contact.id)
    expect(identities).toHaveLength(4)
    for (const connection of [sales, support]) {
      expect(identities.find((item) => item.identityKey === `${connection.id}:business:customer`)).toMatchObject({
        externalId: "business:customer",
        connection: { id: connection.id, label: connection.label, status: "draft" },
      })
    }
    expect(identities.find((item) => item.identityKey === "100")).toMatchObject({ externalId: "100", connection: null })
    expect(identities.find((item) => item.identityKey === foreignKey)).toMatchObject({ externalId: foreignKey, connection: null })
  } finally {
    await closeTracerFixture(database)
  }
})

test("inbox assignment and takeover leases reject stale or competing writers", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const first = { database, projectId, actorId: "agent-1" }
  const second = { database, projectId, actorId: "agent-2" }
  try {
    await createAgent(first, { id: "agent", name: "Agent", slug: "agent", configuration: { model: "openai/gpt-4.1-mini" } })
    await database.execute(sql`insert into build_conversations(id,project_id,agent_id,channel,external_conversation_id) values ('conversation-1',${projectId},'agent','telegram','telegram:conversation-1'),('conversation-2',${projectId},'agent','telegram','telegram:conversation-2')`)
    const ticket = await createTicket(first, { conversationId: "conversation-1", channel: "telegram" })
    const member = await database.execute<{ user_id: string }>(sql`select m."userId" as user_id from member m join project p on p.organization_id=m."organizationId" where p.id=${projectId} limit 1`)
    const assignedUserId = member.rows[0]?.user_id
    if (!assignedUserId) throw new Error("Fixture organization member was not seeded.")
    // AI turns advance the bigint fence before the first human lease exists.
    await database.execute(sql`update build_conversations set owner_fence=3 where project_id=${projectId} and id='conversation-1'`)
    const initial = await getConversationOwnership(first, "conversation-1")
    const claimed = await takeoverConversation(first, { conversationId: "conversation-1", expectedVersion: Number(initial!.version) })
    expect(initial).toMatchObject({ mode: "ai", version: 3 })
    expect(claimed).toMatchObject({ mode: "human", version: 4 })
    await assert.rejects(() => takeoverConversation(second, { conversationId: "conversation-1" }), { code: "CONFLICT", status: 409 })
    await assert.rejects(() => takeoverConversation(first, { conversationId: "conversation-1", expectedVersion: 3 }), { code: "CONFLICT", status: 409 })
    const reclaimed = await takeoverConversation(first, { conversationId: "conversation-1", expectedVersion: claimed!.version })
    if (!reclaimed) throw new Error("Conversation could not be reclaimed by its current owner.")
    expect(reclaimed.version).toBe(5)
    const handoffs = await database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from build_operation_events
      where project_id=${projectId} and event_type='handoff' and conversation_id='conversation-1'
    `)
    expect(handoffs.rows[0]?.count).toBe("1")
    const assigned = await assignTicket(first, { ticketId: ticket.id, assigneeUserId: assignedUserId, expectedVersion: ticket.version })
    await assert.rejects(() => assignTicket(first, { ticketId: ticket.id, assigneeUserId: assignedUserId, expectedVersion: ticket.version }), /assignment changed/)
    await assert.rejects(() => resumeConversation(second, { conversationId: "conversation-1", expectedVersion: reclaimed.version }), { code: "CONFLICT", status: 409 })
    await resumeConversation(first, { conversationId: "conversation-1", expectedVersion: reclaimed.version, leaseToken: reclaimed.leaseToken! })
    expect(await getConversationOwnership(first, "conversation-1")).toMatchObject({ mode: "ai", version: 6 })
    const ownershipEvents = await database.execute<{ fence: string }>(sql`select fence from build_conversation_ownership_events where project_id=${projectId} and conversation_id='conversation-1' order by fence`)
    expect(ownershipEvents.rows.map((row) => Number(row.fence))).toEqual([4, 5, 6])
    expect(assigned.assigneeUserId).toBe(assignedUserId)

    // An AI escalation reserves the queue, not an individual support lease.
    await createConversationService(first).claim("conversation-2", {
      type: "human", id: "team:support", reason: "Customer requested support",
    })
    const queued = await getConversationOwnership(first, "conversation-2")
    const queueClaim = await takeoverConversation(first, {
      conversationId: "conversation-2", expectedVersion: queued!.version,
    })
    expect(queued).toMatchObject({ mode: "human", canReply: false, canTakeover: true })
    await assert.rejects(() => sendHumanReply(second, {
      conversationId: "conversation-2", text: "Must claim before replying",
    }), { code: "CONFLICT", status: 409 })
    expect(await getConversationOwnership(first, "conversation-2"))
      .toMatchObject({ canReply: true, canTakeover: true })
    expect(await getConversationOwnership(second, "conversation-2"))
      .toMatchObject({ canReply: false, canTakeover: false })
    await assert.rejects(() => takeoverConversation(second, {
      conversationId: "conversation-2", expectedVersion: queueClaim!.version,
    }), { code: "CONFLICT", status: 409 })
    await resumeConversation(first, {
      conversationId: "conversation-2", expectedVersion: queueClaim!.version,
      leaseToken: queueClaim!.leaseToken!,
    })
    // A later runtime handoff must not inherit the stale AI-mode lease row.
    await createConversationService(first).claim("conversation-2", {
      type: "human", id: "team:support", reason: "Customer requested support again",
    })
    const queuedAgain = await getConversationOwnership(second, "conversation-2")
    expect(queuedAgain).toMatchObject({ mode: "human", canReply: false, canTakeover: true })
    await takeoverConversation(second, {
      conversationId: "conversation-2", expectedVersion: queuedAgain!.version,
    })
  } finally {
    await closeTracerFixture(database)
  }
})

test("Telegram campaign snapshot is idempotent and feeds delivery and knowledge analytics", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database), actorId: "agent-1" }
  try {
    const contact = await createContact(context, { externalId: "telegram:300", displayName: "Customer" })
    const campaign = await createCampaign(context, { name: "Release", channel: "telegram", template: { text: "Hello {{name}}" }, audienceFilter: { contactIds: [contact.id] } })
    expect((await snapshotCampaignAudience(context, campaign.id)).eligibleCount).toBe(1)
    expect((await snapshotCampaignAudience(context, campaign.id)).eligibleCount).toBe(1)
    expect((await queueCampaignDeliveries(context, campaign.id)).queuedCount).toBe(1)
    expect((await queueCampaignDeliveries(context, campaign.id)).queuedCount).toBe(0)
    const claimed = await claimCampaignDeliveries(context, { limit: 10 })
    expect(claimed).toHaveLength(1)
    await acknowledgeCampaignDelivery(context, { deliveryId: claimed[0]!.id, state: "delivered", providerMessageId: "provider-1" })
    expect((await listCampaignDeliveries(context, { campaignId: campaign.id })).items[0]?.state).toBe("delivered")
    expect((await getCampaign(context, campaign.id)).status).toBe("completed")

    await recordFeedback(context, { question: "How do I change my plan?", sentiment: "negative", channel: "telegram" })
    const gaps = await refreshKnowledgeGapSuggestions(context)
    expect(gaps.items[0]?.question).toBe("How do I change my plan?")
    expect((await listKnowledgeGapSuggestions(context)).items[0]?.negativeCount).toBe(1)
    expect((await getOperationalAnalytics(context)).csat.responses).toBe(0)

    await createAgent(context, { id: "agent", name: "Agent", slug: "agent", configuration: { model: "openai/gpt-4.1-mini" } })
    await database.execute(sql`insert into build_conversations(id,project_id,agent_id,channel,external_conversation_id) values ('conversation-2',${context.projectId},'agent','telegram','telegram:conversation-2')`)
    const ticket = await createTicket(context, { conversationId: "conversation-2", contactId: contact.id, channel: "telegram" })
    const survey = await requestCsat(context, { ticketId: ticket.id, contactId: contact.id, channel: "telegram" })
    await submitCsat(context, { surveyId: survey.id, rating: 5, comment: "Great" })
    expect((await getOperationalAnalytics(context)).csat.responses).toBe(1)
  } finally {
    await closeTracerFixture(database)
  }
})

test("campaign suppression predicates freeze recipient state and zero-audience runs complete", async () => {
  const database = await createTracerFixture()
  const context = { database, projectId: getTracerProjectId(database), actorId: "campaign-operator" }
  try {
    const withEmail = await createContact(context, { externalId: "telegram:filter-1", displayName: "Email customer", email: "customer@example.com" })
    const withoutEmail = await createContact(context, { externalId: "telegram:filter-2", displayName: "Phone customer", phone: "+5511999999999" })
    const campaign = await createCampaign(context, {
      name: "Suppressed email customers",
      channel: "telegram",
      template: { text: "Hello" },
      audienceFilter: { contactIds: [withEmail.id, withoutEmail.id] },
      suppressionFilter: { hasEmail: true },
    })
    const snapshot = await snapshotCampaignAudience(context, campaign.id)
    expect(snapshot).toMatchObject({ audienceCount: 2, suppressedCount: 1, eligibleCount: 1 })
    const audience = await database.execute<{ contact_id: string; state: string; suppression_reason: string | null }>(sql`select contact_id,state,suppression_reason from build_campaign_audience where project_id=${context.projectId} and campaign_id=${campaign.id} order by contact_id`)
    expect(audience.rows).toHaveLength(2)
    expect(audience.rows.find((row) => row.contact_id === withEmail.id)).toEqual({ contact_id: withEmail.id, state: "suppressed", suppression_reason: "Campaign suppression filter matched." })
    expect(audience.rows.find((row) => row.contact_id === withoutEmail.id)).toEqual({ contact_id: withoutEmail.id, state: "eligible", suppression_reason: null })

    const empty = await createCampaign(context, {
      name: "No recipients",
      channel: "telegram",
      template: { text: "No one" },
      audienceFilter: { contactIds: ["missing-contact"] },
    })
    await snapshotCampaignAudience(context, empty.id)
    await queueCampaignDeliveries(context, empty.id)
    expect((await getCampaign(context, empty.id)).status).toBe("completed")
  } finally {
    await closeTracerFixture(database)
  }
})

test("routing honors organization membership, availability and capacity", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId, actorId: "routing-operator" }
  try {
    await createAgent(context, { id: "routing-agent", name: "Routing agent", slug: "routing-agent", configuration: { model: "openai/gpt-4.1-mini" } })
    const member = await database.execute<{ user_id: string }>(sql`select m."userId" as user_id from member m join project p on p.organization_id=m."organizationId" where p.id=${projectId} limit 1`)
    const userId = member.rows[0]?.user_id
    if (!userId) throw new Error("Fixture organization member was not seeded.")
    const team = await createTeam(context, { name: "Capacity team" })
    await setTeamMember(context, { teamId: team.id, userId, availability: "online", maxConcurrent: 1 })
    await createRoutingRule(context, { name: "Capacity route", conditions: { channel: "telegram" }, teamId: team.id })
    await database.execute(sql`
      insert into build_conversations(id,project_id,agent_id,channel,external_conversation_id)
      values ('routing-conversation-1',${projectId},'routing-agent','telegram','telegram:routing-1'),('routing-conversation-2',${projectId},'routing-agent','telegram','telegram:routing-2')
    `)
    const first = await createTicket(context, { conversationId: "routing-conversation-1", channel: "telegram" })
    const second = await createTicket(context, { conversationId: "routing-conversation-2", channel: "telegram" })
    expect(first).toMatchObject({ teamId: team.id, assigneeUserId: userId })
    expect(second).toMatchObject({ teamId: team.id, assigneeUserId: null })
    await assert.rejects(
      () => assignTicket(context, { ticketId: first.id, assigneeUserId: "foreign-user", expectedVersion: first.version }),
      /organization/i,
    )
    await database.execute(sql`update build_team_members set availability='offline' where organization_id=(select organization_id from project where id=${projectId}) and team_id=${team.id} and user_id=${userId}`)
    expect((await getTicket(context, second.id)).assigneeUserId).toBeNull()
  } finally {
    await closeTracerFixture(database)
  }
})

test("enabled macros apply bounded ticket actions with version protection", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId, actorId: "macro-operator" }
  try {
    await createAgent(context, { id: "macro-agent", name: "Macro agent", slug: "macro-agent", configuration: { model: "openai/gpt-4.1-mini" } })
    await database.execute(sql`insert into build_conversations(id,project_id,agent_id,channel,external_conversation_id) values ('macro-conversation',${projectId},'macro-agent','telegram','telegram:macro')`)
    const ticket = await createTicket(context, { conversationId: "macro-conversation", channel: "telegram" })
    const macro = await createMacro(context, {
      name: "Escalate billing",
      body: "I am escalating this to billing.",
      actions: [{ type: "set_priority", priority: "urgent" }, { type: "add_tag", tag: "billing" }, { type: "set_status", status: "pending" }],
    })
    const applied = await applyMacro(context, { macroId: macro.id, ticketId: ticket.id, expectedVersion: ticket.version })
    expect(applied).toMatchObject({ ticketId: ticket.id, status: "pending", priority: "urgent", tags: ["billing"], version: ticket.version + 1 })
    expect((await getTicket(context, ticket.id)).tags).toEqual(["billing"])
    await assert.rejects(
      () => applyMacro(context, { macroId: macro.id, ticketId: ticket.id, expectedVersion: ticket.version }),
      /changed/i,
    )
  } finally {
    await closeTracerFixture(database)
  }
})

test("Telegram campaign worker delivers through the provider outbox and human replies append once", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId, actorId: "human-1", idempotencyKey: "campaign-run-1" }
  const originalFetch = globalThis.fetch
  process.env.BETTER_AUTH_SECRET = "b".repeat(64)
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {})
    return Response.json({ ok: true, result: { message_id: 900 + requests.length, chat: { id: 777 } } })
  }) as typeof fetch
  try {
    const member = await database.execute<{ id: string }>(sql`select u.id from "user" u join member m on m."userId"=u.id join project p on p.organization_id=m."organizationId" where p.id=${projectId} limit 1`)
    context.actorId = member.rows[0]!.id
    await database.execute(sql`update "user" set name='Ada Support',image='https://example.test/ada.png' where id=${context.actorId}`)
    const agent = await createAgent(context, { id: "agent-worker", name: "Worker", slug: "worker", configuration: { model: "openai/gpt-4.1-mini", appearance: { avatarUrl: null, avatarStyle: "wink", avatarColor: "violet" } } })
    const connection = await createChannelConnection(context, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentId: agent.id,
      channel: "telegram",
      label: "Campaign bot",
      credentials: { token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    })
    await database.execute(sql`update build_channel_connection set status='connected' where project_id=${projectId} and id=${connection.id}::uuid`)
    const contact = await createContact(context, { externalId: "telegram:777", displayName: "Customer" })
    await upsertContactIdentity(context, { contactId: contact.id, channel: "telegram", identityKey: `${connection.id}:777` })
    const campaign = await createCampaign(context, { name: "Worker campaign", channel: "telegram", connectionId: connection.id, template: { text: "Hello {{name}}" }, audienceFilter: { contactIds: [contact.id] } })
    await snapshotCampaignAudience(context, campaign.id)
    await queueCampaignDeliveries(context, campaign.id)

    const admitted = await processNextCampaignDelivery(context, { connectionId: connection.id })
    expect(admitted.status).toBe("sending")
    const campaignJob = await claimNextChannelJob(database)
    expect(campaignJob?.kind).toBe("deliver_outbound")
    if (!campaignJob) throw new Error("Campaign delivery did not enqueue a channel job.")
    expect(await processChannelJob(campaignJob, async () => ({ messages: [] }), database)).toEqual({ sentMessageIds: ["901"] })
    await completeChannelJob(database, campaignJob)

    const sent = await listCampaignDeliveries(context, { campaignId: campaign.id })
    expect(sent.items[0]).toMatchObject({ state: "sent", providerMessageId: "901" })
    const receipt = await acknowledgeCampaignDelivery(context, { deliveryId: sent.items[0]!.id, state: "delivered", providerMessageId: "901" })
    expect(receipt).toMatchObject({ state: "delivered", providerMessageId: "901" })
    const inbound = await enqueueTelegramUpdate(context, connection.id, {
      update_id: 1001,
      message: { message_id: 1001, chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Customer" }, text: "Thanks" },
    })
    expect(inbound.accepted).toBe(true)
    expect((await listCampaignDeliveries(context, { campaignId: campaign.id })).items[0]?.state).toBe("replied")
    const inboundJob = await claimNextChannelJob(database)
    if (!inboundJob) throw new Error("Inbound reply did not enqueue a channel job.")
    await processChannelJob(inboundJob, async () => ({ messages: [] }), database)
    await completeChannelJob(database, inboundJob)
    const eventCount = await database.execute<{ messages: string; campaigns: string }>(sql`
      select
        (select count(*)::text from build_operation_events where project_id=${projectId} and event_type='message_sent') as messages,
        (select count(*)::text from build_operation_events where project_id=${projectId} and event_type='campaign_sent') as campaigns
    `)
    expect(eventCount.rows[0]).toEqual({ messages: "1", campaigns: "1" })

    const ticket = await createTicket(context, { conversationId: admitted.conversationId, channel: "telegram" })
    const supportTeam = await createTeam(context, { name: "Support" })
    await setTeamMember(context, { teamId: supportTeam.id, userId: context.actorId })
    await assignTicket(context, { ticketId: ticket.id, teamId: supportTeam.id, expectedVersion: ticket.version })
    await createConversationService(context).claim(admitted.conversationId!, { type: "human", id: supportTeam.id, reason: "Agent escalated to Support" })
    const ownership = await takeoverConversation(context, { conversationId: admitted.conversationId })
    const replyContext = { ...context, idempotencyKey: "human-reply-1" }
    await assert.rejects(
      () =>
        sendHumanReply(
          { ...context, idempotencyKey: "unsafe-attachment-url" },
          {
            conversationId: admitted.conversationId,
            connectionId: connection.id,
            text: "This must not persist.",
            attachments: [{ type: "document", url: "javascript:alert(1)" }],
          }
        ),
      /absolute HTTP\(S\) URLs/i,
    )
    const reply = await sendHumanReply(replyContext, { conversationId: admitted.conversationId, connectionId: connection.id, text: "A human is here." })
    const assigned = await getTicket(context, ticket.id)
    expect(assigned).toMatchObject({ assigneeUserId: context.actorId, assigneeName: "Ada Support", teamId: supportTeam.id })
    const otherTeam = await createTeam(context, { name: "Another team" })
    const reassigned = await assignTicket(context, { ticketId: ticket.id, teamId: otherTeam.id, expectedVersion: assigned.version })
    const replay = await sendHumanReply(replyContext, { conversationId: admitted.conversationId, connectionId: connection.id, text: "A human is here." })
    expect(await getTicket(context, ticket.id)).toEqual(reassigned)
    expect((await listTicketEvents(context, ticket.id)).filter(event => event.eventType === "human_reply_queued")).toHaveLength(1)
    expect(reply).toMatchObject({ appended: true, queued: true, deduplicated: false })
    expect(replay).toMatchObject({ appended: false, queued: true, deduplicated: true, messageId: reply.messageId })
    expect(ownership?.mode).toBe("human")

    const messages = await database.execute<{ count: string }>(sql`
      select count(*)::text from build_conversation_messages
      where project_id=${projectId} and conversation_id=${admitted.conversationId} and metadata_json->>'source'='human'
    `)
    expect(messages.rows[0]?.count).toBe("1")
    const conversationId = admitted.conversationId
    assert(conversationId)
    const aiMessage = await createConversationService(context).appendMessage(conversationId, {
      role: "assistant", content: "An agent reply", status: "completed", metadata: {},
    })
    const customerMessage = await createConversationService(context).appendMessage(conversationId, {
      role: "user", content: "Customer reply", status: "completed", metadata: { source: "human", actorId: context.actorId },
    })
    const listMessages = buildOperations.find(operation => operation.name === "build_list_conversation_messages")!
    const readTranscript = async () => await listMessages.execute(context, { conversationId }) as { items: Array<{ id: string; author: unknown }> }
    const transcript = await readTranscript()
    expect(transcript.items.find(message => message.id === reply.messageId)?.author).toEqual({
      id: context.actorId, name: "Ada Support", image: "https://example.test/ada.png",
    })
    expect(transcript.items.find(message => message.id === aiMessage.id)?.author).toMatchObject({
      id: agent.id, name: "Worker", agentAvatar: { avatarUrl: null, avatarStyle: "wink", avatarColor: "violet" },
    })
    expect(transcript.items.find(message => message.id === customerMessage.id)?.author).toBeNull()
    const humanJob = await claimNextChannelJob(database)
    expect(humanJob?.kind).toBe("deliver_outbound")
    if (!humanJob) throw new Error("Human reply did not enqueue a channel job.")
    await processChannelJob(humanJob, async () => ({ messages: [] }), database)
    await completeChannelJob(database, humanJob)
    expect(requests.map((request) => request.text)).toEqual(["Hello Customer", "A human is here."])

    // Outbox rejection must leave both the transcript and the assignment untouched.
    await assert.rejects(() => sendHumanReply({ ...context, idempotencyKey: "wrong-address" }, {
      conversationId, connectionId: connection.id, externalConversationId: "another-customer", text: "Must not persist",
    }), /conversation identity does not match/)
    expect(await getTicket(context, ticket.id)).toEqual(reassigned)
    expect((await readTranscript()).items).toHaveLength(transcript.items.length)
    const nextReply = await sendHumanReply({ ...context, idempotencyKey: "human-reply-2" }, {
      conversationId, connectionId: connection.id, text: "I will handle this conversation.",
    })
    expect(nextReply).toMatchObject({ appended: true, queued: true })
    expect(await getTicket(context, ticket.id)).toMatchObject({ assigneeUserId: context.actorId, teamId: null })
    expect((await listTicketEvents(context, ticket.id)).filter(event => event.eventType === "assigned").at(-1)?.payload)
      .toMatchObject({ assigneeUserId: context.actorId, teamId: null, reason: "human_reply" })

    await database.execute(sql`update "user" set name='',email='ada-support@example.test',image=null where id=${context.actorId}`)
    expect((await getTicket(context, ticket.id)).assigneeName).toBe("ada-support@example.test")
    expect((await readTranscript()).items.find(message => message.id === reply.messageId)?.author).toEqual({
      id: context.actorId, name: "ada-support@example.test", image: null,
    })

    // Persisted metadata must not expose a profile outside this organization.
    await database.execute(sql`insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values ('foreign-author','Private name','foreign@example.test',false,now(),now())`)
    await database.execute(sql`update build_conversation_messages set metadata_json=jsonb_set(metadata_json,'{actorId}','"foreign-author"'::jsonb) where id=${reply.messageId} and project_id=${projectId}`)
    expect((await readTranscript()).items.find(message => message.id === reply.messageId)?.author).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
    await closeTracerFixture(database)
  }
})

test("scheduled campaigns admit atomically and never claim paused or newly suppressed recipients", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId, actorId: "scheduler" }
  try {
    await createAgent(context, { id: "agent", name: "Agent", slug: "agent", configuration: { model: "openai/gpt-4.1-mini" } })
    const contact = await createContact(context, { externalId: "telegram:scheduled", displayName: "Scheduled customer" })
    const future = new Date(Date.now() + 60_000).toISOString()
    const campaign = await createCampaign(context, {
      name: "Scheduled release",
      channel: "telegram",
      scheduledAt: future,
      template: { text: "Hello {{name}}" },
      audienceFilter: { contactIds: [contact.id] },
    })

    expect((await enqueueDueCampaigns(context)).processedCount).toBe(0)
    expect(await listCampaignProjectsWithPendingWork(database, 10)).toEqual([])

    await updateCampaign(context, campaign.id, { scheduledAt: new Date(Date.now() - 1_000).toISOString() })
    const admitted = await enqueueDueCampaigns(context)
    expect(admitted.processedCount).toBe(1)
    expect(admitted.items[0]?.queued.queuedCount).toBe(1)
    expect(await listCampaignProjectsWithPendingWork(database, 10)).toEqual([projectId])

    await setCampaignStatus(context, { campaignId: campaign.id, status: "paused" })
    expect(await claimCampaignDeliveries(context, { limit: 10 })).toHaveLength(0)
    await setCampaignStatus(context, { campaignId: campaign.id, status: "running" })
    await suppressCampaignContact(context, { contactId: contact.id, reason: "customer request" })
    expect(await claimCampaignDeliveries(context, { limit: 10 })).toHaveLength(0)
    expect((await listCampaignDeliveries(context, { campaignId: campaign.id })).items[0]?.state).toBe("suppressed")
  } finally {
    await closeTracerFixture(database)
  }
})

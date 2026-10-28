import { createHash } from "node:crypto"

import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  csatSubmissionSchema,
  assertOperationsChannelCapability,
  type BuildChannel,
  operationsChannelSchema,
  operationsPageSchema,
  ticketInputSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  agentAppearanceSchema,
} from "@/src/lib/build/contracts"
import { normalizedAttachmentSchema } from "@/src/lib/build/channels"
import { scopedTracerTransaction } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import { operationId } from "../context"
import { createConversationService } from "../conversations"
import { enqueueOutboundEnvelope } from "../channels/service"
import {
  assertChanged,
  decodeJson,
  ensureRows,
  iso,
  jsonValue,
  pageCursor,
  pageLimit,
  prepareOperations,
  sqlAnd,
} from "./database"
import { assertTicketAssignment, resolveRoutingWithExecutor } from "./teams"
import { ensureEscalationTicket } from "./ticket-escalation"

type TicketRow = {
  id: string
  project_id: string
  conversation_id: string
  contact_id: string | null
  contact_name?: string | null
  assignee_name?: string | null
  assignee_image?: string | null
  team_name?: string | null
  channel: string
  subject: string
  status: string
  priority: string
  tags_json: unknown
  assignee_user_id: string | null
  team_id: string | null
  snooze_until: unknown
  first_response_at: unknown
  last_message_at: unknown
  resolved_at: unknown
  version: number
  created_at: unknown
  updated_at: unknown
  recent_updated_at?: string
  needs_takeover?: boolean
}

function ticket(row: TicketRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    contactName: row.contact_name ?? null,
    channel: operationsChannelSchema.parse(row.channel),
    subject: row.subject,
    status: ticketStatusSchema.parse(row.status),
    priority: ticketPrioritySchema.parse(row.priority),
    tags: decodeJson<string[]>(row.tags_json, []),
    needsTakeover: row.needs_takeover === true,
    assigneeUserId: row.assignee_user_id,
    assigneeName: row.assignee_name ?? null,
    assigneeImage: row.assignee_image ?? null,
    teamName: row.team_name ?? null,
    teamId: row.team_id,
    snoozeUntil: iso(row.snooze_until),
    firstResponseAt: iso(row.first_response_at),
    lastMessageAt: iso(row.last_message_at),
    resolvedAt: iso(row.resolved_at),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

// Assignment can name a queue before anyone claims the conversation. Only a
// live lease for its current human owner means the handoff is being handled.
const ticketNeedsTakeover = sql`(
  t.status IN ('open', 'pending') AND EXISTS (
    SELECT 1 FROM build_conversations conversation
    WHERE conversation.project_id=t.project_id AND conversation.id=t.conversation_id
      AND conversation.status='handed_off' AND conversation.owner_type='human'
      AND NOT EXISTS (
        SELECT 1 FROM build_conversation_ownership lease
        WHERE lease.project_id=conversation.project_id AND lease.conversation_id=conversation.id
          AND lease.mode='human' AND lease.owner_user_id=conversation.owner_id
          AND (lease.lease_expires_at IS NULL OR lease.lease_expires_at>now())
      )
  )
)`

async function appendTicketEvent(
  database: BuildContext["database"],
  projectId: string,
  ticketId: string,
  eventType: string,
  actorId: string | undefined,
  payload: unknown
) {
  await database.execute(sql`
    insert into build_ticket_events(id,project_id,ticket_id,event_type,actor_id,payload_json)
    values (${operationId("ticket_event")},${projectId},${ticketId},${eventType},${actorId ?? null},${jsonValue(payload)})
  `)
}

export async function createTicket(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = ticketInputSchema.strict().parse(value)
  return ctx.database.transaction(async (tx) => {
    const conversation = await tx.execute(sql`select 1 from build_conversations where project_id=${ctx.projectId} and id=${input.conversationId}`)
    if (!conversation.rows[0]) throw new Error(`Conversation '${input.conversationId}' was not found.`)
    if (input.contactId) {
      const contact = await tx.execute(sql`select 1 from build_contacts where project_id=${ctx.projectId} and id=${input.contactId}`)
      if (!contact.rows[0]) throw new Error(`Contact '${input.contactId}' was not found.`)
    }
    const route = await resolveRoutingWithExecutor(tx, ctx.projectId, {
      channel: input.channel,
      priority: input.priority,
      tags: input.tags,
    })
    await assertTicketAssignment(tx, ctx.projectId, route)
    const id = operationId("ticket")
    const result = await tx.execute<TicketRow & { inserted: boolean }>(sql`
      insert into build_inbox_tickets(id,project_id,conversation_id,contact_id,channel,subject,status,priority,tags_json,assignee_user_id,team_id,last_message_at)
      values (${id},${ctx.projectId},${input.conversationId},${input.contactId ?? null},${input.channel},${input.subject ?? ""},${input.status},${input.priority},${jsonValue(input.tags)},${route.assigneeUserId},${route.teamId},now())
      on conflict (project_id,conversation_id) do update set
        contact_id=coalesce(excluded.contact_id,build_inbox_tickets.contact_id),
        channel=excluded.channel,
        assignee_user_id=coalesce(build_inbox_tickets.assignee_user_id,excluded.assignee_user_id),
        team_id=coalesce(build_inbox_tickets.team_id,excluded.team_id),
        last_message_at=now(),
        updated_at=now()
      returning *,xmax=0 as inserted
    `)
    const row = ensureRows(result.rows, "Inbox ticket", input.conversationId)
    await appendTicketEvent(tx, ctx.projectId, row.id, row.inserted ? "created" : "message_received", ctx.actorId, { channel: input.channel, ruleId: route.ruleId })
    if (row.inserted) {
      await tx.execute(sql`
        insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
        values (${operationId("event")},${ctx.projectId},'ticket_created',${row.conversation_id},${row.contact_id},${row.channel},${jsonValue({ ticketId: row.id, ruleId: route.ruleId, teamId: row.team_id, assigneeUserId: row.assignee_user_id })})
      `)
    }
    return ticket(row)
  })
}

export async function getTicket(context: BuildContext, id: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<TicketRow>(sql`
    select t.*, ${ticketNeedsTakeover} as needs_takeover, c.display_name as contact_name, coalesce(nullif(trim(u.name),''),u.email) as assignee_name, u.image as assignee_image, team.name as team_name from build_inbox_tickets t
    left join build_contacts c on c.project_id=t.project_id and c.id=t.contact_id
    left join "user" u on u.id=t.assignee_user_id
    left join build_teams team on team.id=t.team_id
    where t.project_id=${ctx.projectId} and t.id=${id}
  `)
  return ticket(ensureRows(result.rows, "Inbox ticket", id))
}

export const listTicketSchema = operationsPageSchema.extend({
  agentId: z.string().min(1).max(128).optional(),
  search: z.string().max(300).optional(),
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  teamId: z.string().max(128).optional(),
  assigneeUserId: z.string().max(128).optional(),
  channel: operationsChannelSchema.optional(),
  queue: z.enum(["mine", "mentions", "unassigned"]).optional(),
  order: z.enum(["id", "recent"]).default("id"),
})

export async function listTickets(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = listTicketSchema.parse(value ?? {})
  const limit = pageLimit(input.limit)
  const predicates = [sql`t.project_id=${ctx.projectId}`]
  if (input.agentId) predicates.push(sql`exists (
    select 1 from build_conversations c where c.project_id=t.project_id
      and c.id=t.conversation_id and c.agent_id=${input.agentId}
  )`)
  if (input.status) predicates.push(sql`t.status=${input.status}`)
  if (input.priority) predicates.push(sql`t.priority=${input.priority}`)
  if (input.teamId) predicates.push(sql`t.team_id=${input.teamId}`)
  if (input.assigneeUserId) predicates.push(sql`t.assignee_user_id=${input.assigneeUserId}`)
  if (input.channel) predicates.push(sql`t.channel=${input.channel}`)
  if (input.queue === "mine")
    predicates.push(ctx.actorId ? sql`t.assignee_user_id=${ctx.actorId}` : sql`false`)
  if (input.queue === "unassigned") predicates.push(sql`t.assignee_user_id is null`)
  if (input.queue === "mentions") {
    const actor = ctx.actorId
      ? await ctx.database.execute<{ email: string }>(sql`select email from "user" where id=${ctx.actorId}`)
      : { rows: [] }
    const email = actor.rows[0]?.email
    if (!email) predicates.push(sql`false`)
    else {
      // Match an explicit @email mention, not a substring or another address.
      const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const mention = `(^|[^[:alnum:]_@.+-])@${escaped}(?![[:alnum:]_@+-]|\\.[[:alnum:]])`
      predicates.push(sql`exists (
        select 1 from build_ticket_notes n
        where n.project_id=t.project_id and n.ticket_id=t.id and n.body ~* ${mention}
      )`)
    }
  }
  if (input.cursor) {
    if (input.order === "recent") {
      let cursor: [string, string]
      try {
        cursor = z.tuple([z.string().min(1), z.string().min(1)]).parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString())
        )
        if (!Number.isFinite(Date.parse(cursor[0]))) throw new Error("Invalid date")
      } catch {
        throw new TracerError("VALIDATION_ERROR", "Invalid recent conversations cursor.")
      }
      predicates.push(sql`(t.updated_at,t.id)<(${cursor[0]}::timestamptz,${cursor[1]})`)
    } else predicates.push(sql`t.id>${pageCursor(input.cursor)}`)
  }
  if (input.search) {
    const query = `%${input.search}%`
    predicates.push(sql`(t.subject ilike ${query} or t.id ilike ${query} or t.conversation_id ilike ${query} or c.display_name ilike ${query} or c.email ilike ${query} or c.phone ilike ${query})`)
  }
  const result = await ctx.database.execute<TicketRow>(sql`
    select t.*, ${ticketNeedsTakeover} as needs_takeover, t.updated_at::text as recent_updated_at, c.display_name as contact_name, coalesce(nullif(trim(u.name),''),u.email) as assignee_name, u.image as assignee_image, team.name as team_name from build_inbox_tickets t
    left join build_contacts c on c.project_id=t.project_id and c.id=t.contact_id
    left join "user" u on u.id=t.assignee_user_id
    left join build_teams team on team.id=t.team_id
    where ${sqlAnd(predicates)}
    order by ${input.order === "recent" ? sql`t.updated_at desc,t.id desc` : sql`t.id asc`}
    limit ${limit + 1}
  `)
  const rows = result.rows.slice(0, limit)
  const last = rows.at(-1)
  const nextCursor = result.rows.length > limit && last
    ? input.order === "recent"
      ? Buffer.from(JSON.stringify([last.recent_updated_at, last.id])).toString("base64url")
      : last.id
    : null
  return { items: rows.map(ticket), nextCursor }
}

export async function updateTicket(context: BuildContext, id: string, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    subject: z.string().max(500).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    snoozeUntil: z.string().datetime().nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  }).strict().parse(value)
  const before = await getTicket(ctx, id)
  const nextStatus = input.status ?? before.status
  const versionPredicate = input.expectedVersion === undefined ? sql`` : sql`and version=${input.expectedVersion}`
  const result = await ctx.database.execute(sql`
    update build_inbox_tickets set status=${nextStatus},priority=${input.priority ?? before.priority},subject=${input.subject ?? before.subject},tags_json=${jsonValue(input.tags ?? before.tags)},snooze_until=${input.snoozeUntil ?? before.snoozeUntil},resolved_at=case when ${nextStatus} in ('solved','closed') then coalesce(resolved_at,now()) else null end,version=version+1,updated_at=now()
    where project_id=${ctx.projectId} and id=${id} ${versionPredicate}
  `)
  assertChanged(result, "The ticket changed. Reload it before applying this update.")
  const updated = await getTicket(ctx, id)
  await appendTicketEvent(ctx.database, ctx.projectId, id, "updated", ctx.actorId, { from: before, to: updated })
  if (nextStatus === "solved" || nextStatus === "closed") {
    await ctx.database.execute(sql`
      insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
      values (${operationId("event")},${ctx.projectId},'ticket_resolved',${updated.conversationId},${updated.contactId},${updated.channel},${jsonValue({ ticketId: id, status: nextStatus })})
    `)
  }
  return updated
}

export async function addTicketNote(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ ticketId: z.string().min(1).max(128), body: z.string().trim().min(1).max(16_000) }).strict().parse(value)
  await getTicket(ctx, input.ticketId)
  const id = operationId("ticket_note")
  await ctx.database.execute(sql`insert into build_ticket_notes(id,project_id,ticket_id,body,author_id) values (${id},${ctx.projectId},${input.ticketId},${input.body},${ctx.actorId ?? null})`)
  await appendTicketEvent(ctx.database, ctx.projectId, input.ticketId, "internal_note", ctx.actorId, { noteId: id })
  return { id, projectId: ctx.projectId, ticketId: input.ticketId, body: input.body, authorId: ctx.actorId ?? null }
}

export async function listTicketNotes(context: BuildContext, ticketId: string) {
  const ctx = await prepareOperations(context)
  await getTicket(ctx, ticketId)
  const result = await ctx.database.execute<{
    id: string
    body: string
    author_id: string | null
    author_name: string | null
    author_image: string | null
    created_at: unknown
  }>(sql`
    select n.id,n.body,n.author_id,u.name as author_name,u.image as author_image,n.created_at
    from build_ticket_notes n left join "user" u on u.id=n.author_id
    where n.project_id=${ctx.projectId} and n.ticket_id=${ticketId}
    order by n.created_at asc,n.id asc limit 1000
  `)
  return result.rows.map((row) => ({
    id: row.id, ticketId, body: row.body, authorId: row.author_id,
    authorName: row.author_name, authorImage: row.author_image,
    createdAt: iso(row.created_at),
  }))
}

/** Operator-only profile enrichment; customer transcripts and model history stay unchanged. */
export async function listConversationMessages(
  context: BuildContext,
  conversationId: string,
  options: { limit?: number; before?: string } = {}
) {
  const ctx = await prepareOperations(context)
  const page = await createConversationService(ctx).listMessages(conversationId, options)
  const senderId = (message: (typeof page.items)[number]) =>
    message.role === "assistant" && message.metadata.source === "human" &&
    typeof message.metadata.actorId === "string" ? message.metadata.actorId : null
  const ids = [...new Set(page.items.flatMap(message => senderId(message) ?? []))]
  const profiles = ids.length ? await ctx.database.execute<{
    id: string; name: string; image: string | null
  }>(sql`
    select u.id,coalesce(nullif(btrim(u.name),''),u.email) as name,u.image from "user" u
    join member m on m."userId"=u.id and m."organizationId"=${ctx.organizationId}
    where u.id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
  `) : { rows: [] }
  const authors = new Map(profiles.rows.map(profile => [profile.id, profile]))
  const agentResult = await ctx.database.execute<{ id: string; name: string; appearance: unknown }>(sql`
    select a.id,a.name,a.current_config_json->'appearance' as appearance
    from build_conversations c join build_agents a on a.id=c.agent_id and a.project_id=c.project_id
    where c.project_id=${ctx.projectId} and c.id=${conversationId}
  `)
  const agent = agentResult.rows[0]
  const appearance = agent ? agentAppearanceSchema.parse(agent.appearance) : null
  const agentAuthor = agent && appearance ? {
    id: agent.id,
    name: agent.name,
    image: appearance.avatarUrl,
    agentAvatar: {
      avatarUrl: appearance.avatarUrl,
      avatarStyle: appearance.avatarStyle,
      avatarColor: appearance.avatarColor,
    },
  } : null
  return {
    ...page,
    items: page.items.map(message => ({
      ...message,
      author: message.role === "assistant" && message.metadata.source !== "human"
        ? agentAuthor
        : authors.get(senderId(message) ?? "") ?? null,
    })),
  }
}

export async function assignTicket(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ ticketId: z.string().min(1).max(128), assigneeUserId: z.string().max(128).nullable().default(null), teamId: z.string().max(128).nullable().default(null), expectedVersion: z.number().int().positive() }).strict().parse(value)
  await assertTicketAssignment(ctx.database, ctx.projectId, input)
  const result = await ctx.database.execute(sql`update build_inbox_tickets set assignee_user_id=${input.assigneeUserId},team_id=${input.teamId},version=version+1,updated_at=now() where project_id=${ctx.projectId} and id=${input.ticketId} and version=${input.expectedVersion}`)
  assertChanged(result, "The ticket assignment changed. Reload it before assigning again.")
  await appendTicketEvent(ctx.database, ctx.projectId, input.ticketId, "assigned", ctx.actorId, { assigneeUserId: input.assigneeUserId, teamId: input.teamId })
  return getTicket(ctx, input.ticketId)
}

type OwnershipRow = { project_id: string; conversation_id: string; mode: string; owner_user_id: string | null; team_id: string | null; lease_token: string | null; lease_expires_at: unknown; version: number; updated_at: unknown }

function ownership(row: OwnershipRow | undefined) {
  if (!row) return null
  return { projectId: row.project_id, conversationId: row.conversation_id, mode: row.mode as "ai" | "human", ownerUserId: row.owner_user_id, teamId: row.team_id, leaseToken: row.lease_token, leaseExpiresAt: iso(row.lease_expires_at), version: row.version, updatedAt: iso(row.updated_at) }
}

export async function getConversationOwnership(context: BuildContext, conversationId: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<{
    project_id: string; id: string; owner_type: string; owner_id: string | null;
    owner_fence: number | string; updated_at: unknown; lease: OwnershipRow | null;
  }>(sql`
    select c.project_id,c.id,c.owner_type,c.owner_id,c.owner_fence,c.updated_at,
           row_to_json(o) as lease
    from build_conversations c
    left join build_conversation_ownership o
      on o.project_id=c.project_id and o.conversation_id=c.id
    where c.project_id=${ctx.projectId} and c.id=${conversationId}
  `)
  const row = result.rows[0]
  if (!row) return null
  const lease = row.lease
  const activeLease = row.owner_type === "human" &&
    lease?.mode === "human" && lease.owner_user_id === row.owner_id &&
    (lease.lease_expires_at === null || new Date(String(lease.lease_expires_at)).getTime() > Date.now())
  const canReply = Boolean(ctx.actorId && row.owner_id === ctx.actorId && activeLease)
  return {
    projectId: row.project_id,
    conversationId: row.id,
    mode: row.owner_type === "human" ? "human" as const : "ai" as const,
    ownerUserId: row.owner_id,
    teamId: lease?.team_id ?? null,
    leaseToken: canReply ? lease?.lease_token ?? null : null,
    leaseExpiresAt: activeLease ? iso(lease?.lease_expires_at) : null,
    version: lease?.version ?? Number(row.owner_fence),
    updatedAt: iso(row.updated_at),
    canReply,
    canTakeover: Boolean(ctx.actorId && (!activeLease || row.owner_id === ctx.actorId)),
  }
}

/** Claims a human lease. A live lease owned by another user is a conflict. */
export async function takeoverConversation(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ conversationId: z.string().trim().min(1).max(256), teamId: z.string().max(128).nullable().default(null), leaseSeconds: z.number().int().min(30).max(86_400).default(900), expectedVersion: z.number().int().positive().optional() }).strict().parse(value)
  if (!ctx.actorId) throw new Error("An actorId is required to take over a conversation.")
  if (input.teamId) {
    const team = await ctx.database.execute(sql`select 1 from build_teams where organization_id=${ctx.organizationId} and id=${input.teamId} and enabled=true`)
    if (!team.rows[0]) throw new Error(`Team '${input.teamId}' is not enabled.`)
  }
  return ctx.database.transaction(async (tx) => {
    const conversationResult = await tx.execute<{ owner_type: string; owner_id: string | null; owner_fence: number | string; channel: string }>(sql`
      select owner_type,owner_id,owner_fence,channel from build_conversations
      where project_id=${ctx.projectId} and id=${input.conversationId} for update
    `)
    const conversation = conversationResult.rows[0]
    if (!conversation) throw new Error(`Conversation '${input.conversationId}' was not found.`)
    const current = await tx.execute<OwnershipRow>(sql`select * from build_conversation_ownership where project_id=${ctx.projectId} and conversation_id=${input.conversationId} for update`)
    const row = current.rows[0]
    // PostgreSQL returns bigint fences as strings. Normalize before comparing
    // versions or incrementing the fence recorded in ownership events.
    const ownerFence = Number(conversation.owner_fence)
    const currentVersion = row?.version ?? ownerFence
    if (input.expectedVersion !== undefined && currentVersion !== input.expectedVersion) throw new TracerError("CONFLICT", "Conversation ownership changed. Reload before taking it over.")
    // Runtime handoff reserves a support queue without acquiring a user lease.
    // Only a matching, live human lease can block another teammate's claim.
    const liveOther = conversation.owner_type === "human" && row?.mode === "human" && row.owner_user_id === conversation.owner_id && conversation.owner_id !== ctx.actorId && (!row.lease_expires_at || new Date(String(row.lease_expires_at)).getTime() > Date.now())
    if (liveOther) throw new TracerError("CONFLICT", "Conversation is currently owned by another agent.")
    await ensureEscalationTicket(tx, ctx.projectId, input.conversationId, {
      actorId: ctx.actorId,
      teamId: input.teamId,
      reopen: conversation.owner_type !== "human",
    })
    const token = operationId("lease")
    await tx.execute(sql`
      update build_conversations
      set owner_type='human',owner_id=${ctx.actorId},owner_fence=owner_fence+1,status='handed_off',updated_at=now()
      where project_id=${ctx.projectId} and id=${input.conversationId}
    `)
    await tx.execute(sql`
      insert into build_conversation_ownership_events
        (id,project_id,conversation_id,from_owner_type,from_owner_id,to_owner_type,to_owner_id,fence,reason)
      values
        (${operationId("ownership_event")},${ctx.projectId},${input.conversationId},${conversation.owner_type},${conversation.owner_id},'human',${ctx.actorId},${ownerFence + 1},'Inbox takeover')
    `)
    if (conversation.owner_type !== "human") {
      await tx.execute(sql`
        insert into build_operation_events
          (id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
        values
          (${operationId("event")},${ctx.projectId},'handoff',${input.conversationId},
           (select nullif(metadata_json->>'contactId','') from build_conversations where project_id=${ctx.projectId} and id=${input.conversationId}),
           ${conversation.channel},${JSON.stringify({
             fromOwnerType: conversation.owner_type,
             fromOwnerId: conversation.owner_id,
             toOwnerType: "human",
             toOwnerId: ctx.actorId,
             ownerFence: ownerFence + 1,
             reason: "Inbox takeover",
           })}::jsonb)
      `)
    }
    await tx.execute(sql`
      insert into build_conversation_ownership(project_id,conversation_id,mode,owner_user_id,team_id,lease_token,lease_expires_at,version,updated_at)
      values (${ctx.projectId},${input.conversationId},'human',${ctx.actorId},${input.teamId},${token},now()+(${input.leaseSeconds} * interval '1 second'),${currentVersion + 1},now())
      on conflict (project_id,conversation_id) do update set mode='human',owner_user_id=excluded.owner_user_id,team_id=excluded.team_id,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,version=build_conversation_ownership.version+1,updated_at=now()
    `)
    const next = await tx.execute<OwnershipRow>(sql`select * from build_conversation_ownership where project_id=${ctx.projectId} and conversation_id=${input.conversationId}`)
    return ownership(ensureRows(next.rows, "Conversation ownership", input.conversationId))
  })
}

export async function resumeConversation(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ conversationId: z.string().trim().min(1).max(256), expectedVersion: z.number().int().positive(), leaseToken: z.string().max(256).optional() }).strict().parse(value)
  if (!ctx.actorId) throw new Error("An actorId is required to resume a conversation.")
  const result = await ctx.database.transaction(async (tx) => {
    const conversation = await tx.execute<{ owner_type: string; owner_id: string | null; owner_fence: number | string }>(sql`select owner_type,owner_id,owner_fence from build_conversations where project_id=${ctx.projectId} and id=${input.conversationId} for update`)
    if (!conversation.rows[0] || conversation.rows[0].owner_type !== "human" || conversation.rows[0].owner_id !== ctx.actorId) throw new TracerError("CONFLICT", "Conversation ownership changed or is held by another agent.")
    const changed = await tx.execute(sql`
      update build_conversation_ownership set mode='ai',owner_user_id=null,lease_token=null,lease_expires_at=null,version=version+1,updated_at=now()
      where project_id=${ctx.projectId} and conversation_id=${input.conversationId} and mode='human' and owner_user_id=${ctx.actorId} and version=${input.expectedVersion} ${input.leaseToken ? sql`and lease_token=${input.leaseToken}` : sql``}
    `)
    assertChanged(changed, "Conversation ownership changed or is held by another agent.")
    await tx.execute(sql`update build_conversations set owner_type='ai',owner_id=null,owner_fence=owner_fence+1,status='active',updated_at=now() where project_id=${ctx.projectId} and id=${input.conversationId}`)
    await tx.execute(sql`
      insert into build_conversation_ownership_events
        (id,project_id,conversation_id,from_owner_type,from_owner_id,to_owner_type,to_owner_id,fence,reason)
      values
        (${operationId("ownership_event")},${ctx.projectId},${input.conversationId},'human',${ctx.actorId},'ai',null,${Number(conversation.rows[0]!.owner_fence) + 1},'Inbox conversation resumed by AI')
    `)
    return changed
  })
  void result
  return getConversationOwnership(ctx, input.conversationId)
}

export async function listTicketEvents(context: BuildContext, ticketId: string) {
  const ctx = await prepareOperations(context)
  await getTicket(ctx, ticketId)
  const result = await ctx.database.execute<{ id: string; event_type: string; actor_id: string | null; payload_json: unknown; created_at: unknown }>(sql`select id,event_type,actor_id,payload_json,created_at from build_ticket_events where project_id=${ctx.projectId} and ticket_id=${ticketId} order by created_at asc,id asc limit 1000`)
  return result.rows.map((row) => ({ id: row.id, ticketId, eventType: row.event_type, actorId: row.actor_id, payload: decodeJson(row.payload_json, {}), createdAt: iso(row.created_at) }))
}

/**
 * Append an operator reply, assign its ticket to the sender and admit the
 * reply to the provider outbox atomically. Ownership is checked while the
 * conversation row is locked, so a stale inbox tab cannot send after takeover
 * has moved the conversation to another actor.
 */
export async function sendHumanReply(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const actorId = ctx.actorId
  if (!actorId) throw new Error("An actorId is required to send a human reply.")
  const input = z.object({
    conversationId: z.string().trim().min(1).max(256),
    connectionId: z.string().trim().min(1).max(128).optional(),
    externalConversationId: z.string().trim().min(1).max(500).optional(),
    text: z.string().trim().min(1).max(100_000),
    attachments: z.array(normalizedAttachmentSchema).max(20).default([]),
    clientMessageId: z.string().trim().min(1).max(200).optional(),
  }).strict().parse(value)
  const stableKey = ctx.idempotencyKey ?? input.clientMessageId ?? operationId("human_reply")
  const messageId = `human_message_${createHash("sha256").update(`${ctx.projectId}:${input.conversationId}:${stableKey}`).digest("hex")}`

  return ctx.database.transaction(async (tx) => {
    const transactionContext = { ...ctx, database: scopedTracerTransaction(ctx.database, tx) }
    const conversation = await tx.execute<{
      id: string
      owner_type: string
      owner_id: string | null
      channel: string
      external_conversation_id: string | null
    }>(sql`
      select id,owner_type,owner_id,channel,external_conversation_id
      from build_conversations
      where project_id=${ctx.projectId} and id=${input.conversationId}
      for update
    `)
    const row = ensureRows(conversation.rows, "Conversation", input.conversationId)
    if (row.owner_type !== "human" || row.owner_id !== ctx.actorId)
      throw new TracerError("CONFLICT", "Take over this conversation before replying. Another teammate may have claimed it.", { details: { reason: "OWNERSHIP_CHANGED" } })

    // The canonical conversation owner is necessary but not sufficient: an
    // expired lease must stop a stale inbox tab from appending more replies.
    // Runtime handoff can establish the canonical owner before a lease row is
    // materialized, so a missing row remains compatible with that path. Once a
    // lease row exists, it is the authoritative fencing record.
    const ownershipResult = await tx.execute<Pick<OwnershipRow, "mode" | "owner_user_id" | "lease_expires_at">>(sql`
      select mode,owner_user_id,lease_expires_at
      from build_conversation_ownership
      where project_id=${ctx.projectId} and conversation_id=${input.conversationId}
      for update
    `)
    const lease = ownershipResult.rows[0]
    if (
      lease &&
      (lease.mode !== "human" ||
        lease.owner_user_id !== ctx.actorId ||
        (lease.lease_expires_at !== null &&
          new Date(String(lease.lease_expires_at)).getTime() <= Date.now()))
    ) {
      throw new TracerError("CONFLICT", "Your conversation lease expired. Take over the conversation again before replying.", { details: { reason: "LEASE_EXPIRED" } })
    }
    await assertTicketAssignment(tx, ctx.projectId, { assigneeUserId: actorId, teamId: null })

    const connection = await tx.execute<{ id: string; channel: string }>(sql`
      select id,channel
      from build_channel_connection
      where project_id=${ctx.projectId}
        ${input.connectionId ? sql`and id=${input.connectionId}::uuid` : sql`and id in (select connection_id from build_channel_message where project_id=${ctx.projectId} and conversation_id=${input.conversationId} order by created_at desc limit 1)`}
      limit 1
    `)
    const channel = ensureRows(connection.rows, "Channel connection", input.connectionId ?? input.conversationId)
    if (channel.channel !== row.channel) throw new Error("Human reply connection does not match the conversation channel.")
    assertOperationsChannelCapability(row.channel as Parameters<typeof assertOperationsChannelCapability>[0], "outbound")
    const externalConversationId = input.externalConversationId ?? row.external_conversation_id
    if (!externalConversationId) throw new Error("Conversation has no external channel address for this reply.")
    const contact = await tx.execute<{ contact_id: string | null }>(sql`
      select contact_id
      from build_channel_message
      where project_id=${ctx.projectId} and conversation_id=${input.conversationId} and contact_id is not null
      order by created_at desc,id desc limit 1
    `)
    const contactId = contact.rows[0]?.contact_id ?? null
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into build_conversation_messages
        (id,project_id,conversation_id,role,content_json,status,metadata_json,completed_at)
      values (${messageId},${ctx.projectId},${input.conversationId},'assistant',${JSON.stringify({ text: input.text, attachments: input.attachments })}::jsonb,'completed',${JSON.stringify({ source: "human", actorId: ctx.actorId, clientMessageId: stableKey })}::jsonb,now())
      on conflict (project_id,id) do nothing
      returning id
    `)
    const ticket = await tx.execute<{ id: string; assignee_user_id: string | null; team_id: string | null; sender_team_id: string | null }>(sql`
      select t.id,t.assignee_user_id,t.team_id,tm.team_id as sender_team_id
      from build_inbox_tickets t
      left join build_teams team on team.id=t.team_id and team.organization_id=${ctx.organizationId} and team.enabled=true
      left join build_team_members tm on tm.organization_id=team.organization_id and tm.team_id=team.id and tm.user_id=${ctx.actorId}
      where t.project_id=${ctx.projectId} and t.conversation_id=${input.conversationId}
      for update of t
    `)
    const ticketRow = ticket.rows[0]
    // A retry must not undo an assignment made after the original reply.
    if (inserted.rows[0]) {
      await tx.execute(sql`
        update build_conversations set last_message_at=now(),updated_at=now()
        where project_id=${ctx.projectId} and id=${input.conversationId}
      `)
      if (ticketRow) {
        // Keep the queue only when the sender belongs to its enabled team.
        const teamId = ticketRow.sender_team_id
        await tx.execute(sql`
          update build_inbox_tickets
          set assignee_user_id=${ctx.actorId},team_id=${teamId},
            first_response_at=coalesce(first_response_at,now()),last_message_at=now(),
            status=case when status='pending' then 'open' else status end,version=version+1,updated_at=now()
          where project_id=${ctx.projectId} and id=${ticketRow.id}
        `)
        if (ticketRow.assignee_user_id !== ctx.actorId || ticketRow.team_id !== teamId) {
          await appendTicketEvent(tx, ctx.projectId, ticketRow.id, "assigned", ctx.actorId, {
            assigneeUserId: ctx.actorId, teamId, reason: "human_reply",
          })
        }
      }
    }

    // Persist the reply, assignment, audit and outbox admission together. A
    // rejected delivery must not leave a message or a new assignee behind.
    const queued = await enqueueOutboundEnvelope(transactionContext, {
      connectionId: String(channel.id),
      conversationId: input.conversationId,
      contactId: contactId ?? undefined,
      channel: channel.channel as BuildChannel,
      idempotencyKey: `human:${input.conversationId}:${stableKey}`,
      text: input.text,
      attachments: input.attachments,
      metadata: { source: "human", actorId: ctx.actorId, clientMessageId: stableKey },
    }, externalConversationId)
    if (ticketRow && queued.queued) {
      await appendTicketEvent(tx, ctx.projectId, ticketRow.id, "human_reply_queued", ctx.actorId, { messageId, channelMessageId: queued.messageId ?? null })
    }
    return {
      conversationId: input.conversationId,
      messageId,
      appended: Boolean(inserted.rows[0]),
      ticketId: ticketRow?.id ?? null,
      channelMessageId: queued.messageId ?? null,
      channelJobId: queued.channelJobId ?? null,
      queued: queued.queued || queued.deduplicated,
      deduplicated: queued.deduplicated,
    }
  })
}

export async function requestCsat(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ ticketId: z.string().max(128).optional(), conversationId: z.string().max(256).optional(), contactId: z.string().max(128).optional(), channel: operationsChannelSchema.default("telegram"), expiresAt: z.string().datetime().optional() }).strict().parse(value)
  if (!input.ticketId && !input.conversationId) throw new Error("A CSAT request requires ticketId or conversationId.")
  if (input.ticketId) {
    const ticket = await ctx.database.execute(sql`select 1 from build_inbox_tickets where project_id=${ctx.projectId} and id=${input.ticketId}`)
    if (!ticket.rows[0]) throw new Error(`Inbox ticket '${input.ticketId}' was not found.`)
  }
  if (input.conversationId) {
    const conversation = await ctx.database.execute(sql`select 1 from build_conversations where project_id=${ctx.projectId} and id=${input.conversationId}`)
    if (!conversation.rows[0]) throw new Error(`Conversation '${input.conversationId}' was not found.`)
  }
  if (input.contactId) {
    const contact = await ctx.database.execute(sql`select 1 from build_contacts where project_id=${ctx.projectId} and id=${input.contactId}`)
    if (!contact.rows[0]) throw new Error(`Contact '${input.contactId}' was not found.`)
  }
  const id = operationId("csat")
  await ctx.database.execute(sql`insert into build_csat_surveys(id,project_id,ticket_id,conversation_id,contact_id,channel,expires_at) values (${id},${ctx.projectId},${input.ticketId ?? null},${input.conversationId ?? null},${input.contactId ?? null},${input.channel},${input.expiresAt ?? null})`)
  return { id, projectId: ctx.projectId, status: "pending" as const, ...input }
}

export async function submitCsat(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = csatSubmissionSchema.strict().parse(value)
  const result = await ctx.database.execute(sql`update build_csat_surveys set status='answered',rating=${input.rating},comment=${input.comment},responded_at=now() where project_id=${ctx.projectId} and id=${input.surveyId} and status='pending'`)
  assertChanged(result, "This CSAT survey is no longer pending.")
  await recordTicketEventForSurvey(ctx, input.surveyId, input.rating, input.comment)
  const survey = await ctx.database.execute<{ ticket_id: string | null; conversation_id: string | null; contact_id: string | null; channel: string | null }>(sql`select ticket_id,conversation_id,contact_id,channel from build_csat_surveys where project_id=${ctx.projectId} and id=${input.surveyId}`)
  const surveyRow = survey.rows[0]
  await ctx.database.execute(sql`
    insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
    values (${operationId("event")},${ctx.projectId},'csat_submitted',${surveyRow?.conversation_id ?? null},${surveyRow?.contact_id ?? null},${surveyRow?.channel ?? null},${jsonValue({ surveyId: input.surveyId, rating: input.rating })})
  `)
  return { surveyId: input.surveyId, status: "answered" as const, rating: input.rating, comment: input.comment }
}

async function recordTicketEventForSurvey(ctx: BuildContext, surveyId: string, rating: number, comment: string) {
  const survey = await ctx.database.execute<{ ticket_id: string | null; conversation_id: string | null }>(sql`select ticket_id,conversation_id from build_csat_surveys where project_id=${ctx.projectId} and id=${surveyId}`)
  const row = survey.rows[0]
  if (row?.ticket_id) await appendTicketEvent(ctx.database, ctx.projectId, row.ticket_id, "csat_submitted", ctx.actorId, { rating, comment, surveyId })
}

export async function listCsat(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ status: z.enum(["pending", "answered", "expired", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.status) predicates.push(sql`status=${input.status}`)
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<{ id: string; ticket_id: string | null; conversation_id: string | null; contact_id: string | null; channel: string | null; status: string; rating: number | null; comment: string; requested_at: unknown; responded_at: unknown; expires_at: unknown }>(sql`select * from build_csat_surveys where ${sqlAnd(predicates)} order by id asc limit ${input.limit + 1}`)
  const rows = result.rows.slice(0, input.limit)
  return { items: rows.map((row) => ({ id: row.id, ticketId: row.ticket_id, conversationId: row.conversation_id, contactId: row.contact_id, channel: row.channel, status: row.status, rating: row.rating, comment: row.comment, requestedAt: iso(row.requested_at), respondedAt: iso(row.responded_at), expiresAt: iso(row.expires_at) })), nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}

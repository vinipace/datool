import { sql } from "drizzle-orm"

import { operationId, type BuildContext } from "../context"
import { resolveRoutingWithExecutor } from "./teams"

/**
 * Called inside the ownership transaction, with the conversation row locked.
 * A ticket records a support case independently of the current chat owner.
 */
export async function ensureEscalationTicket(
  executor: Pick<BuildContext["database"], "execute">,
  projectId: string,
  conversationId: string,
  options: { actorId?: string; teamId?: string | null; reopen: boolean }
) {
  const existing = await executor.execute<{ id: string }>(sql`
    select id from build_inbox_tickets
    where project_id=${projectId} and conversation_id=${conversationId}
    for update
  `)
  if (existing.rows[0]) {
    const id = existing.rows[0].id
    if (options.reopen) {
      const reopened = await executor.execute(sql`
        update build_inbox_tickets
        set status='open',resolved_at=null,snooze_until=null,version=version+1,updated_at=now()
        where project_id=${projectId} and id=${id} and status in ('solved','closed')
        returning id
      `)
      if (reopened.rows.length) {
        await executor.execute(sql`
          insert into build_ticket_events(id,project_id,ticket_id,event_type,actor_id,payload_json)
          values (${operationId("ticket_event")},${projectId},${id},'reopened',${options.actorId ?? null},'{"reason":"escalation"}'::jsonb)
        `)
      }
    }
    return id
  }

  const result = await executor.execute<{
    channel: string
    contact_id: string | null
    contact_status: string | null
    subject: string | null
  }>(sql`
    select c.channel,contact.id as contact_id,contact.status as contact_status,
      coalesce(
        (select m.content_json #>> '{}' from build_conversation_messages m
         where m.project_id=c.project_id and m.conversation_id=c.id
           and m.role='user' and jsonb_typeof(m.content_json)='string'
         order by m.ordinal asc limit 1),
        (select m.content_json->>'text' from build_channel_message m
         where m.project_id=c.project_id and m.conversation_id=c.id and m.direction='inbound'
         order by m.created_at asc,m.id asc limit 1)
      ) as subject
    from build_conversations c
    left join build_contacts contact on contact.project_id=c.project_id and contact.id=c.metadata_json->>'contactId'
    where c.project_id=${projectId} and c.id=${conversationId}
  `)
  const conversation = result.rows[0]
  if (!conversation)
    throw new Error(`Conversation '${conversationId}' was not found.`)
  const route = await resolveRoutingWithExecutor(executor, projectId, {
    channel: conversation.channel,
    priority: "normal",
    tags: [],
    contactStatus: conversation.contact_status ?? undefined,
  })
  // Runtime handoffs can name a team; only accept an enabled team in this organization.
  const team = options.teamId
    ? await executor.execute<{ id: string }>(sql`
        select id from build_teams
        where id=${options.teamId} and enabled=true
          and organization_id=(select organization_id from project where id=${projectId})
      `)
    : null
  const teamId = team?.rows[0]?.id ?? route.teamId
  const assigneeUserId = teamId === route.teamId ? route.assigneeUserId : null
  const id = operationId("ticket")
  const subject = (conversation.subject ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500)
  const inserted = await executor.execute<{ id: string }>(sql`
    insert into build_inbox_tickets
      (id,project_id,conversation_id,contact_id,channel,subject,assignee_user_id,team_id,last_message_at)
    values
      (${id},${projectId},${conversationId},${conversation.contact_id},${conversation.channel},${subject},${assigneeUserId},${teamId},now())
    on conflict (project_id,conversation_id) do nothing
    returning id
  `)
  if (!inserted.rows.length) {
    const ticket = await executor.execute<{ id: string }>(sql`
      select id from build_inbox_tickets where project_id=${projectId} and conversation_id=${conversationId}
    `)
    return ticket.rows[0]!.id
  }
  const payload = JSON.stringify({
    reason: "escalation",
    ticketId: id,
    ruleId: route.ruleId,
    teamId,
    assigneeUserId,
  })
  await executor.execute(sql`
    insert into build_ticket_events(id,project_id,ticket_id,event_type,actor_id,payload_json)
    values (${operationId("ticket_event")},${projectId},${id},'created',${options.actorId ?? null},${payload}::jsonb)
  `)
  await executor.execute(sql`
    insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json)
    values (${operationId("event")},${projectId},'ticket_created',${conversationId},${conversation.contact_id},${conversation.channel},${payload}::jsonb)
  `)
  return id
}

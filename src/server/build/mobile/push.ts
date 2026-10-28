import { sql } from "drizzle-orm"
import { z } from "zod"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { organizationHasBillingAccess } from "@/src/server/billing/store"

// Aliases are shared by admission and delivery. Rechecking current membership,
// assignment, subscription, and session avoids stale notifications after removal.
const eligible = sql`
  s."expiresAt">now() and s."userId"=d.user_id
  and m.role ~ '(^|,)[[:space:]]*(owner|admin|member)[[:space:]]*(,|$)'
  and d.created_at<=e.created_at and t.status in ('open','pending')
  and (e.kind='assignment' or c.owner_type='human')
  and (e.actor_id is null or e.actor_id<>d.user_id)
  and case
    when t.assignee_user_id is not null then t.assignee_user_id=d.user_id
    when exists(select 1 from member om where om."organizationId"=p.organization_id and om."userId"=c.owner_id)
      then c.owner_id=d.user_id
    when t.team_id is not null then exists(
      select 1 from build_team_members tm join build_teams team on team.id=tm.team_id
      where tm.team_id=t.team_id and tm.user_id=d.user_id and team.enabled
        and tm.organization_id=p.organization_id)
    else true
  end
`
const joins = sql`
  join project p on p.id=e.project_id
  join build_inbox_tickets t on t.project_id=e.project_id and t.conversation_id=e.conversation_id
  join build_conversations c on c.project_id=e.project_id and c.id=e.conversation_id
  join member m on m."organizationId"=p.organization_id and m."userId"=d.user_id
  join session s on s.id=d.session_id
`
type Job = { id: string; token: string; user_id: string; device_id: string; attempts: number; provider_ticket: string | null }
const ticketSchema = z.object({ status: z.enum(["ok", "error"]), id: z.string().optional(), details: z.object({ error: z.string().optional() }).optional() })
const endpoint = "https://exp.host/--/api/v2/push/"

async function retry(database: TracerDatabase, job: Job, error: string) {
  await database.execute(sql`update inbox_mobile_push_jobs set
    status=${job.attempts >= 6 ? "failed" : "pending"},last_error=${error.slice(0, 120)},
    available_at=now()+(${Math.min(3600, 30 * 2 ** job.attempts)} * interval '1 second')
    where id=${job.id} and status in ('sending','receipt')`)
}
async function forgetDevice(database: TracerDatabase, job: Job) {
  // Do not remove a replacement token or an installation claimed by a new user.
  await database.execute(sql`delete from inbox_mobile_devices
    where id=${job.device_id} and token=${job.token} and user_id=${job.user_id}`)
  await database.execute(sql`update inbox_mobile_push_jobs set status='cancelled' where id=${job.id}`)
}

/** Belll's leased outbox/receipt pattern, scoped to Datool's human inbox. */
export async function drainInboxPush(database: TracerDatabase) {
  await database.transaction(async tx => {
    const events = await tx.execute<{ id: string }>(sql`
      select id from inbox_mobile_events where expanded_at is null
      order by created_at,id limit 50 for update skip locked`)
    for (const event of events.rows) {
      await tx.execute(sql`
        insert into inbox_mobile_push_jobs(id,event_id,device_id,token,user_id)
        select e.id || ':' || d.id,e.id,d.id,d.token,d.user_id
        from inbox_mobile_events e join inbox_mobile_devices d on d.project_id=e.project_id
        ${joins} where e.id=${event.id} and ${eligible}
        on conflict (event_id,device_id) do nothing`)
      await tx.execute(sql`update inbox_mobile_events set expanded_at=now() where id=${event.id}`)
    }
  })
  await database.execute(sql`update inbox_mobile_push_jobs set status='failed',last_error='Receipt expired'
    where status='receipt' and receipt_expires_at<=now()`)
  await database.execute(sql`update inbox_mobile_push_jobs set status='failed',last_error='Attempts exhausted'
    where status='sending' and attempts>=6 and available_at<=now()`)
  const jobs = await database.execute<Job>(sql`
    update inbox_mobile_push_jobs set status='sending',attempts=attempts+1,available_at=now()+interval '5 minutes'
    where id in (select id from inbox_mobile_push_jobs
      where status in ('pending','sending') and attempts<6 and available_at<=now()
      order by available_at,id limit 5 for update skip locked) returning *`)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`
  for (const job of jobs.rows) {
    const current = await database.execute<{ project_id: string; ticket_id: string; organization_id: string; kind: string }>(sql`
      select e.project_id,t.id as ticket_id,p.organization_id,e.kind
      from inbox_mobile_push_jobs j join inbox_mobile_events e on e.id=j.event_id
      join inbox_mobile_devices d on d.id=j.device_id and d.token=j.token and d.user_id=j.user_id
      ${joins} where j.id=${job.id} and ${eligible}`)
    const target = current.rows[0]
    if (!target || !await organizationHasBillingAccess(target.organization_id)) {
      await database.execute(sql`update inbox_mobile_push_jobs set status='cancelled' where id=${job.id}`)
      continue
    }
    try {
      const response = await fetch(endpoint + "send", {
        method: "POST", headers, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ to: job.token, title: target.kind === "handoff" ? "An agent needs your help" : "A ticket was assigned to you",
          body: "Open Datool Inbox to continue the conversation.", sound: "default", channelId: "inbox",
          data: { projectId: target.project_id, ticketId: target.ticket_id },
          collapseId: target.ticket_id, tag: target.ticket_id }),
      })
      if (!response.ok) throw new Error("Push request failed")
      const { data } = z.object({ data: ticketSchema }).parse(await response.json())
      if (data.status === "ok" && data.id) {
        await database.execute(sql`update inbox_mobile_push_jobs set status='receipt',provider_ticket=${data.id},
          available_at=now()+interval '15 minutes',receipt_expires_at=now()+interval '24 hours'
          where id=${job.id} and status='sending'`)
      } else if (data.details?.error === "DeviceNotRegistered") await forgetDevice(database, job)
      else await retry(database, job, data.details?.error ?? "Invalid push ticket")
    } catch { await retry(database, job, "Push provider request failed") }
  }
  // Claim receipt checks as well, so multiple Build workers do not poll a batch
  // repeatedly while a provider is slow. Missing receipts remain bounded.
  const waiting = await database.execute<Job>(sql`
    update inbox_mobile_push_jobs set available_at=now()+interval '15 minutes'
    where id in (select id from inbox_mobile_push_jobs where status='receipt' and available_at<=now()
      order by available_at limit 100 for update skip locked) returning *`)
  if (!waiting.rows.length) return
  try {
    const response = await fetch(endpoint + "getReceipts", { method: "POST", headers,
      signal: AbortSignal.timeout(15_000), body: JSON.stringify({ ids: waiting.rows.map(j => j.provider_ticket) }) })
    if (!response.ok) return
    const { data } = z.object({ data: z.record(z.string(), ticketSchema) }).parse(await response.json())
    for (const job of waiting.rows) {
      const receipt = data[job.provider_ticket!]
      if (!receipt) continue
      if (receipt.status === "ok") await database.execute(sql`update inbox_mobile_push_jobs
        set status='accepted',last_error=null where id=${job.id} and status='receipt'`)
      else if (receipt.details?.error === "DeviceNotRegistered") await forgetDevice(database, job)
      else await retry(database, job, receipt.details?.error ?? "Push receipt failed")
    }
  } catch { /* Receipt checks retry on their next durable deadline. */ }
}

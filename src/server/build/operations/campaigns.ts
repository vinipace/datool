import { enabledBuildProject } from "../access"
import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  assertOperationsChannelCapability,
  campaignInputSchema,
  getOperationsChannelCapabilities,
  operationsChannelSchema,
} from "@/src/lib/build/contracts"
import type { BuildContext } from "../context"
import { operationId } from "../context"
import { enqueueOutboundEnvelope } from "../channels/service"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  assertChanged,
  decodeJson,
  ensureRows,
  iso,
  jsonValue,
  prepareOperations,
  sqlAnd,
} from "./database"
import { reconcileCampaignStatus } from "./campaign-status"

type CampaignRow = { id: string; project_id: string; name: string; channel: string; connection_id: string | null; status: string; template_json: unknown; audience_filter_json: unknown; suppression_filter_json: unknown; scheduled_at: unknown; created_at: unknown; updated_at: unknown }

type OperationsExecutor = Pick<BuildContext["database"], "execute">

function campaign(row: CampaignRow) {
  return { id: row.id, projectId: row.project_id, name: row.name, channel: operationsChannelSchema.parse(row.channel), connectionId: row.connection_id, status: row.status, template: decodeJson<Record<string, unknown>>(row.template_json, {}), audienceFilter: decodeJson<Record<string, unknown>>(row.audience_filter_json, {}), suppressionFilter: decodeJson<Record<string, unknown>>(row.suppression_filter_json, {}), scheduledAt: iso(row.scheduled_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

type CampaignConnection = { id: string; agent_id: string; channel: string; status: string }

async function resolveCampaignConnection(
  context: BuildContext,
  campaignValue: ReturnType<typeof campaign>,
  requestedConnectionId?: string,
) {
  const ctx = await prepareOperations(context)
  const connectionId = requestedConnectionId ?? campaignValue.connectionId
  const result = await ctx.database.execute<CampaignConnection>(sql`
    select id,agent_id,channel,status
    from build_channel_connection
    where project_id=${ctx.projectId}
      and channel=${campaignValue.channel}
      ${connectionId ? sql`and id=${connectionId}::uuid` : sql`and status='connected'`}
    order by updated_at desc,id asc
    limit 2
  `)
  if (!result.rows.length) {
    throw new Error(
      connectionId
        ? `Channel connection '${connectionId}' was not found for this project.`
        : `Campaign '${campaignValue.id}' needs a connected ${campaignValue.channel} channel connection before it can deliver.`,
    )
  }
  if (!connectionId && result.rows.length > 1) {
    throw new Error(`Campaign '${campaignValue.id}' has more than one connected ${campaignValue.channel} connection; set connectionId before delivering.`)
  }
  const connection = result.rows[0]!
  if (connection.channel !== campaignValue.channel) throw new Error("Campaign connection channel does not match the campaign.")
  if (connection.status !== "connected") throw new Error(`Channel connection '${connection.id}' is not connected.`)
  return connection
}

function renderCampaignText(template: Record<string, unknown>, contact: Record<string, unknown>) {
  const candidate = [template.text, template.body, template.message].find((value) => typeof value === "string")
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("Campaign template must contain a non-empty text, body or message field.")
  const values: Record<string, string> = {
    name: String(contact.display_name ?? ""),
    displayName: String(contact.display_name ?? ""),
    email: String(contact.email ?? ""),
    phone: String(contact.phone ?? ""),
    externalId: String(contact.external_id ?? ""),
  }
  const rendered = candidate.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => values[key] ?? "")
  if (rendered.length > 100_000) throw new Error("Campaign message is too long for channel delivery.")
  return rendered
}

export async function createCampaign(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = campaignInputSchema.strict().parse(value)
  assertOperationsChannelCapability(input.channel, "campaigns")
  if (input.connectionId) {
    const connection = await ctx.database.execute<{ channel: string }>(sql`
      select channel from build_channel_connection
      where project_id=${ctx.projectId} and id=${input.connectionId}::uuid
      limit 1
    `)
    const row = ensureRows(connection.rows, "Channel connection", input.connectionId)
    if (row.channel !== input.channel) throw new Error("Campaign connection channel does not match the campaign channel.")
  }
  const id = operationId("campaign")
  await ctx.database.execute(sql`insert into build_campaigns(id,project_id,name,channel,connection_id,template_json,audience_filter_json,suppression_filter_json,scheduled_at,status) values (${id},${ctx.projectId},${input.name},${input.channel},${input.connectionId ?? null}::uuid,${jsonValue(input.template)},${jsonValue(input.audienceFilter)},${jsonValue(input.suppressionFilter)},${input.scheduledAt ?? null},${input.scheduledAt ? "scheduled" : "draft"})`)
  const result = await ctx.database.execute<CampaignRow>(sql`select * from build_campaigns where project_id=${ctx.projectId} and id=${id}`)
  return campaign(ensureRows(result.rows, "Campaign", id))
}

export async function getCampaign(context: BuildContext, id: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<CampaignRow>(sql`select * from build_campaigns where project_id=${ctx.projectId} and id=${id}`)
  return campaign(ensureRows(result.rows, "Campaign", id))
}

export async function listCampaigns(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional(), status: z.enum(["draft", "scheduled", "running", "paused", "completed", "failed"]).optional(), search: z.string().max(300).optional() }).strict().parse(value ?? {})
  const predicates = [sql`c.project_id=${ctx.projectId}`]
  if (input.status) predicates.push(sql`c.status=${input.status}`)
  if (input.cursor) predicates.push(sql`c.id>${input.cursor}`)
  if (input.search) predicates.push(sql`c.name ilike ${`%${input.search}%`}`)
  const result = await ctx.database.execute<CampaignRow & { audience_count: number; delivered_count: number; replied_count: number }>(sql`
    select c.*,
      count(distinct a.id)::int as audience_count,
      count(d.id) filter (where d.state in ('sent','delivered','read','replied'))::int as delivered_count,
      count(d.id) filter (where d.state='replied')::int as replied_count
    from build_campaigns c
    left join build_campaign_audience a on a.project_id=c.project_id and a.campaign_id=c.id
    left join build_campaign_deliveries d on d.project_id=c.project_id and d.campaign_id=c.id
    where ${sqlAnd(predicates)}
    group by c.id
    order by c.updated_at desc,c.id asc
    limit ${input.limit + 1}
  `)
  const rows = result.rows.slice(0, input.limit)
  return {
    items: rows.map((row) => ({ ...campaign(row), audienceCount: row.audience_count, deliveredCount: row.delivered_count, repliedCount: row.replied_count })),
    nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null,
  }
}

export async function updateCampaign(context: BuildContext, id: string, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = campaignInputSchema.partial().strict().parse(value)
  if (input.channel) assertOperationsChannelCapability(input.channel, "campaigns")
  const before = await getCampaign(ctx, id)
  const nextChannel = input.channel ?? before.channel
  if (input.connectionId) {
    const connection = await ctx.database.execute<{ channel: string }>(sql`select channel from build_channel_connection where project_id=${ctx.projectId} and id=${input.connectionId}::uuid limit 1`)
    const row = ensureRows(connection.rows, "Channel connection", input.connectionId)
    if (row.channel !== nextChannel) throw new Error("Campaign connection channel does not match the campaign channel.")
  }
  const result = await ctx.database.execute(sql`update build_campaigns set name=coalesce(${input.name ?? null},name),channel=${nextChannel},connection_id=coalesce(${input.connectionId ?? null}::uuid,connection_id),template_json=coalesce(${input.template ? jsonValue(input.template) : sql`null`},template_json),audience_filter_json=coalesce(${input.audienceFilter ? jsonValue(input.audienceFilter) : sql`null`},audience_filter_json),suppression_filter_json=coalesce(${input.suppressionFilter ? jsonValue(input.suppressionFilter) : sql`null`},suppression_filter_json),scheduled_at=coalesce(${input.scheduledAt ?? null},scheduled_at),updated_at=now() where project_id=${ctx.projectId} and id=${id}`)
  assertChanged(result, `Campaign '${id}' was not found.`)
  return getCampaign(ctx, id)
}

export async function setCampaignStatus(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ campaignId: z.string().min(1).max(128), status: z.enum(["draft", "scheduled", "running", "paused", "completed", "failed"]) }).strict().parse(value)
  const campaignValue = await getCampaign(ctx, input.campaignId)
  if (input.status === "running") assertOperationsChannelCapability(campaignValue.channel, "campaigns")
  const result = await ctx.database.execute(sql`update build_campaigns set status=${input.status},updated_at=now() where project_id=${ctx.projectId} and id=${input.campaignId}`)
  assertChanged(result, `Campaign '${input.campaignId}' was not found.`)
  return getCampaign(ctx, input.campaignId)
}

/** Snapshot, suppress and queue a campaign from the Inbox/Campaigns UI. */
export async function runCampaign(context: BuildContext, value: unknown) {
  const input = z.object({ campaignId: z.string().min(1).max(128) }).strict().parse(value)
  const snapshot = await snapshotCampaignAudience(context, input.campaignId)
  const queued = await queueCampaignDeliveries(context, input.campaignId)
  return {
    campaign: await getCampaign(context, input.campaignId),
    snapshot,
    queued,
  }
}

function contactFilterPredicates(projectId: string, filter: Record<string, unknown>, alias: "c" | "s" = "c") {
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  const predicates = [sql`${column("project_id")}=${projectId}`]
  if (Array.isArray(filter.contactIds) && filter.contactIds.length) {
    const ids = filter.contactIds.filter((id): id is string => typeof id === "string").slice(0, 10_000)
    if (ids.length) predicates.push(sql`${column("id")} in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`)
  }
  if (typeof filter.emailDomain === "string" && filter.emailDomain.length <= 255) predicates.push(sql`lower(${column("email")}) like ${`%@${filter.emailDomain.toLowerCase()}`}`)
  if (filter.hasPhone === true) predicates.push(sql`${column("phone")} is not null and ${column("phone")}<>''`)
  if (filter.hasEmail === true) predicates.push(sql`${column("email")} is not null and ${column("email")}<>''`)
  return predicates
}

function audiencePredicates(projectId: string, filter: Record<string, unknown>) {
  return [sql`c.status='active'`, ...contactFilterPredicates(projectId, filter)]
}

function hasSupportedContactFilter(filter: Record<string, unknown>) {
  return (
    (Array.isArray(filter.contactIds) && filter.contactIds.some((id) => typeof id === "string")) ||
    (typeof filter.emailDomain === "string" && filter.emailDomain.length <= 255) ||
    filter.hasPhone === true ||
    filter.hasEmail === true
  )
}

type AudienceRow = { id: string; project_id: string; campaign_id: string; contact_id: string; state: string; suppression_reason: string | null; snapshot_at: unknown; updated_at: unknown }

type SnapshotContactRow = { id: string; suppression_reason: string | null }

async function snapshotCampaignAudienceWithExecutor(
  executor: OperationsExecutor,
  projectId: string,
  campaignValue: ReturnType<typeof campaign>,
) {
  const predicates = audiencePredicates(projectId, campaignValue.audienceFilter)
  const suppressionPredicates = contactFilterPredicates(projectId, campaignValue.suppressionFilter, "s")
  const suppressionFilterMatch = hasSupportedContactFilter(campaignValue.suppressionFilter) && suppressionPredicates.length
    ? sql`exists (select 1 from build_contacts s where s.project_id=${projectId} and s.id=c.id and ${sqlAnd(suppressionPredicates)})`
    : sql`false`
  const contacts = await executor.execute<SnapshotContactRow>(sql`
    select c.id,case
      when active_suppression.reason is not null then active_suppression.reason
      when ${suppressionFilterMatch} then 'Campaign suppression filter matched.'
      else null
    end as suppression_reason
    from build_contacts c
    left join lateral (
      select s.reason
      from build_campaign_suppressions s
      where s.project_id=${projectId} and s.contact_id=c.id
        and (s.expires_at is null or s.expires_at>now())
      order by s.created_at desc,s.reason asc
      limit 1
    ) active_suppression on true
    where ${sqlAnd(predicates)}
    order by c.id asc
    limit 10000
  `)
  let inserted = 0
  let suppressed = 0
  for (const row of contacts.rows) {
    const reason = row.suppression_reason ?? null
    const state = reason ? "suppressed" : "eligible"
    await executor.execute(sql`
      insert into build_campaign_audience(id,project_id,campaign_id,contact_id,state,suppression_reason)
      values (${operationId("audience")},${projectId},${campaignValue.id},${row.id},${state},${reason})
      on conflict (project_id,campaign_id,contact_id) do update set
        state=case
          when excluded.state='suppressed' and build_campaign_audience.state not in ('sent','delivered','read','replied') then 'suppressed'
          when build_campaign_audience.state in ('queued','sending','sent','delivered','read','replied','failed') then build_campaign_audience.state
          else excluded.state
        end,
        suppression_reason=case
          when excluded.state='suppressed' then excluded.suppression_reason
          when build_campaign_audience.state in ('sent','delivered','read','replied') then build_campaign_audience.suppression_reason
          else excluded.suppression_reason
        end,
        snapshot_at=now(),updated_at=now()
    `)
    inserted += 1
    if (reason) suppressed += 1
  }
  return { campaignId: campaignValue.id, channel: campaignValue.channel, audienceCount: inserted, suppressedCount: suppressed, eligibleCount: inserted - suppressed }
}

/** Freezes the audience before delivery, making suppression and retry decisions reproducible. */
export async function snapshotCampaignAudience(context: BuildContext, campaignId: string) {
  const ctx = await prepareOperations(context)
  const campaignValue = await getCampaign(ctx, campaignId)
  return ctx.database.transaction((tx) => snapshotCampaignAudienceWithExecutor(tx, ctx.projectId, campaignValue))
}

export async function suppressCampaignContact(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ contactId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(200), expiresAt: z.string().datetime().nullable().default(null) }).strict().parse(value)
  const contact = await ctx.database.execute(sql`select 1 from build_contacts where project_id=${ctx.projectId} and id=${input.contactId}`)
  if (!contact.rows[0]) throw new Error(`Contact '${input.contactId}' was not found.`)
  await ctx.database.execute(sql`insert into build_campaign_suppressions(project_id,contact_id,reason,expires_at) values (${ctx.projectId},${input.contactId},${input.reason},${input.expiresAt}) on conflict (project_id,contact_id,reason) do update set expires_at=excluded.expires_at`)
  await ctx.database.execute(sql`update build_campaign_audience set state='suppressed',suppression_reason=${input.reason},updated_at=now() where project_id=${ctx.projectId} and contact_id=${input.contactId} and state in ('eligible','queued')`)
  return { projectId: ctx.projectId, ...input }
}

/** Creates idempotent delivery jobs from the frozen audience. */
export async function queueCampaignDeliveries(context: BuildContext, campaignId: string) {
  const ctx = await prepareOperations(context)
  return ctx.database.transaction(async (tx) => {
    const current = await tx.execute<CampaignRow>(sql`
      select * from build_campaigns
      where project_id=${ctx.projectId} and id=${campaignId}
      for update
    `)
    const campaignValue = campaign(ensureRows(current.rows, "Campaign", campaignId))
    assertOperationsChannelCapability(campaignValue.channel, "campaigns")
    if (campaignValue.status === "paused") {
      return { campaignId, channel: campaignValue.channel, queuedCount: 0, capabilities: getOperationsChannelCapabilities(campaignValue.channel), paused: true, notDue: false }
    }
    if (!["draft", "scheduled", "running"].includes(campaignValue.status)) {
      throw new Error(`Campaign '${campaignId}' cannot queue deliveries while it is ${campaignValue.status}.`)
    }
    if (campaignValue.scheduledAt && new Date(campaignValue.scheduledAt).getTime() > Date.now()) {
      return { campaignId, channel: campaignValue.channel, queuedCount: 0, capabilities: getOperationsChannelCapabilities(campaignValue.channel), paused: false, notDue: true }
    }
    await tx.execute(sql`
      update build_campaigns set status='running',updated_at=now()
      where project_id=${ctx.projectId} and id=${campaignId}
        and status in ('draft','scheduled','running')
        and (scheduled_at is null or scheduled_at<=now())
    `)
    return queueCampaignDeliveriesWithExecutor(tx, ctx.projectId, campaignValue)
  })
}

async function queueCampaignDeliveriesWithExecutor(
  executor: OperationsExecutor,
  projectId: string,
  campaignValue: ReturnType<typeof campaign>,
) {
  const audienceRows = await executor.execute<AudienceRow>(sql`
    select *
    from build_campaign_audience
    where project_id=${projectId} and campaign_id=${campaignValue.id} and state='eligible'
    order by id asc
    limit 10000
  `)
  let queued = 0
  for (const row of audienceRows.rows) {
    const idempotencyKey = `${campaignValue.id}:${row.id}`
    await executor.execute(sql`
      insert into build_campaign_deliveries(id,project_id,campaign_id,audience_id,channel,idempotency_key,payload_json)
      values (${operationId("delivery")},${projectId},${campaignValue.id},${row.id},${campaignValue.channel},${idempotencyKey},${jsonValue(campaignValue.template)})
      on conflict (project_id,idempotency_key) do nothing
    `)
    const changed = await executor.execute(sql`
      update build_campaign_audience set state='queued',updated_at=now()
      where project_id=${projectId} and id=${row.id} and state='eligible'
    `)
    queued += changed.rowCount ?? 0
  }
  await reconcileCampaignStatus(executor, projectId, campaignValue.id)
  return { campaignId: campaignValue.id, channel: campaignValue.channel, queuedCount: queued, capabilities: getOperationsChannelCapabilities(campaignValue.channel), paused: false, notDue: false }
}

/**
 * Finds project ids that need campaign work without binding a worker-wide
 * database handle to one customer project. The worker creates a scoped
 * BuildContext for each returned project before mutating anything.
 */
export async function listCampaignProjectsWithPendingWork(
  database: TracerDatabase,
  limit = 100,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Campaign work limit must be an integer between 1 and 100.")
  }
  const result = await database.execute<{ project_id: string }>(sql`
    select c.project_id,
      count(distinct d.id) filter (
        where c.status='running' and (
          (d.state='queued' and d.next_attempt_at<=now()) or
          (d.state='sending' and d.updated_at<now()-interval '5 minutes')
        )
      )::int as pending_deliveries,
      count(distinct c.id) filter (
        where c.status='scheduled' and c.scheduled_at is not null and c.scheduled_at<=now()
      )::int as due_campaigns
    from build_campaigns c
    left join build_campaign_deliveries d
      on d.project_id=c.project_id and d.campaign_id=c.id
    where ${enabledBuildProject(sql`c.project_id`)} and (
      (c.status='scheduled' and c.scheduled_at is not null and c.scheduled_at<=now())
      or (c.status='running' and (
        (d.state='queued' and d.next_attempt_at<=now()) or
        (d.state='sending' and d.updated_at<now()-interval '5 minutes')
      ))
    )
    group by c.project_id
    order by c.project_id asc
    limit ${limit}
  `)
  return result.rows.map((row) => row.project_id)
}

export type DueCampaignAdmission = {
  campaignId: string
  snapshot: Awaited<ReturnType<typeof snapshotCampaignAudienceWithExecutor>>
  queued: Awaited<ReturnType<typeof queueCampaignDeliveriesWithExecutor>>
}

/**
 * Atomically admits scheduled campaigns whose time has arrived. Snapshot and
 * delivery creation happen under the same transaction as the scheduled to
 * running transition, so a worker crash cannot leave a partially admitted
 * campaign that another worker may send early.
 */
export async function enqueueDueCampaigns(
  context: BuildContext,
  options: { limit?: number } = {},
): Promise<{ items: DueCampaignAdmission[]; processedCount: number }> {
  const ctx = await prepareOperations(context)
  const input = z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict().parse(options)
  return ctx.database.transaction(async (tx) => {
    const due = await tx.execute<CampaignRow>(sql`
      select *
      from build_campaigns
      where project_id=${ctx.projectId}
        and status='scheduled'
        and scheduled_at is not null
        and scheduled_at<=now()
      order by scheduled_at asc,id asc
      limit ${input.limit}
      for update skip locked
    `)
    const items: DueCampaignAdmission[] = []
    for (const row of due.rows) {
      const campaignValue = campaign(row)
      assertOperationsChannelCapability(campaignValue.channel, "campaigns")
      await tx.execute(sql`
        update build_campaigns set status='running',updated_at=now()
        where project_id=${ctx.projectId} and id=${campaignValue.id} and status='scheduled'
      `)
      const snapshot = await snapshotCampaignAudienceWithExecutor(tx, ctx.projectId, campaignValue)
      const queued = await queueCampaignDeliveriesWithExecutor(tx, ctx.projectId, campaignValue)
      items.push({ campaignId: campaignValue.id, snapshot, queued })
    }
    return { items, processedCount: items.length }
  })
}

type DeliveryRow = { id: string; project_id: string; campaign_id: string; audience_id: string; channel: string; idempotency_key: string; payload_json: unknown; state: string; attempt_count: number; provider_message_id: string | null; last_error: string | null; next_attempt_at: unknown; created_at: unknown; updated_at: unknown; sent_at: unknown }
function delivery(row: DeliveryRow) { return { id: row.id, projectId: row.project_id, campaignId: row.campaign_id, audienceId: row.audience_id, channel: operationsChannelSchema.parse(row.channel), idempotencyKey: row.idempotency_key, payload: decodeJson<Record<string, unknown>>(row.payload_json, {}), state: row.state, attemptCount: row.attempt_count, providerMessageId: row.provider_message_id, lastError: row.last_error, nextAttemptAt: iso(row.next_attempt_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), sentAt: iso(row.sent_at) } }

/** Atomically claims queued deliveries so a channel worker cannot send one twice. */
export async function claimCampaignDeliveries(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict().parse(value ?? {})
  return ctx.database.transaction(async (tx) => {
    const recovered = await tx.execute<{ audience_id: string }>(sql`
      update build_campaign_deliveries d
      set state='queued',last_error='Campaign delivery claim lease expired.',next_attempt_at=now(),updated_at=now()
      where d.project_id=${ctx.projectId} and d.state='sending'
        and d.updated_at<now()-interval '5 minutes'
        and not exists (
          select 1
          from build_channel_message m
          where m.project_id=d.project_id
            and m.content_json->'metadata'->>'campaignDeliveryId'=d.id
        )
      returning d.audience_id
    `)
    for (const row of recovered.rows) {
      await tx.execute(sql`
        update build_campaign_audience set state='queued',updated_at=now()
        where project_id=${ctx.projectId} and id=${row.audience_id} and state='sending'
      `)
    }
    const suppressed = await tx.execute<{ audience_id: string }>(sql`
      update build_campaign_deliveries d
      set state='suppressed',last_error='Campaign recipient is suppressed.',updated_at=now()
      where d.project_id=${ctx.projectId} and d.state='queued'
        and exists (
          select 1
          from build_campaign_suppressions s
          join build_campaign_audience a on a.project_id=s.project_id and a.id=d.audience_id and a.contact_id=s.contact_id
          where s.project_id=d.project_id
            and (s.expires_at is null or s.expires_at>now())
        )
      returning d.audience_id
    `)
    for (const row of suppressed.rows) {
      await tx.execute(sql`
        update build_campaign_audience set state='suppressed',suppression_reason='Campaign recipient is suppressed.',updated_at=now()
        where project_id=${ctx.projectId} and id=${row.audience_id}
      `)
    }
    const running = await tx.execute<{ id: string }>(sql`
      select c.id
      from build_campaigns c
      where c.project_id=${ctx.projectId} and c.status='running'
        and not exists (
          select 1 from build_campaign_deliveries d
          where d.project_id=c.project_id and d.campaign_id=c.id and d.state in ('queued','sending')
        )
    `)
    for (const row of running.rows) await reconcileCampaignStatus(tx, ctx.projectId, row.id)
    const result = await tx.execute<DeliveryRow>(sql`
      with claimed as (
        select d.id
        from build_campaign_deliveries d
        join build_campaigns c on c.project_id=d.project_id and c.id=d.campaign_id
        join build_campaign_audience a on a.project_id=d.project_id and a.id=d.audience_id
        where d.project_id=${ctx.projectId}
          and d.state='queued'
          and d.next_attempt_at<=now()
          and c.status='running'
          and (c.scheduled_at is null or c.scheduled_at<=now())
          and a.state='queued'
        order by d.next_attempt_at asc,d.id asc
        limit ${input.limit}
        for update of d skip locked
      )
      update build_campaign_deliveries d set state='sending',attempt_count=d.attempt_count+1,updated_at=now()
      from claimed where d.project_id=${ctx.projectId} and d.id=claimed.id returning d.*
    `)
    return result.rows.map(delivery)
  })
}

export async function acknowledgeCampaignDelivery(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ deliveryId: z.string().min(1).max(128), state: z.enum(["sent", "delivered", "read", "replied", "failed"]), providerMessageId: z.string().max(512).optional(), error: z.string().max(4_000).optional(), retryAt: z.string().datetime().optional() }).strict().parse(value)
  const existing = await ctx.database.execute<DeliveryRow>(sql`select * from build_campaign_deliveries where project_id=${ctx.projectId} and id=${input.deliveryId} limit 1`)
  const current = ensureRows(existing.rows, "Campaign delivery", input.deliveryId)
  const rank: Record<string, number> = { queued: 0, sending: 1, failed: 0, sent: 2, delivered: 3, read: 4, replied: 5 }
  const targetRank = rank[input.state] ?? 0
  const currentRank = rank[current.state] ?? 0
  if (input.state !== "failed" && currentRank >= targetRank) return delivery(current)
  if (input.state === "failed" && !["queued", "sending"].includes(current.state)) return delivery(current)
  const result = await ctx.database.execute<DeliveryRow>(sql`update build_campaign_deliveries set state=${input.state},provider_message_id=coalesce(${input.providerMessageId ?? null},provider_message_id),last_error=${input.error ?? null},next_attempt_at=coalesce(${input.retryAt ?? null},next_attempt_at),sent_at=case when ${input.state} in ('sent','delivered','read','replied') then coalesce(sent_at,now()) else sent_at end,updated_at=now() where project_id=${ctx.projectId} and id=${input.deliveryId} and state=${current.state} returning *`)
  const row = ensureRows(result.rows, "Campaign delivery", input.deliveryId)
  await ctx.database.execute(sql`update build_campaign_audience set state=${input.state},updated_at=now() where project_id=${ctx.projectId} and id=${row.audience_id}`)
  await ctx.database.execute(sql`insert into build_operation_events(id,project_id,event_type,contact_id,channel,payload_json) select ${operationId("event")},${ctx.projectId},${input.state === "failed" ? "agent_failed" : input.state === "replied" ? "campaign_replied" : input.state === "delivered" ? "campaign_delivered" : "campaign_sent"},a.contact_id,d.channel,${jsonValue({ deliveryId: input.deliveryId, error: input.error ?? null })} from build_campaign_deliveries d join build_campaign_audience a on a.project_id=d.project_id and a.id=d.audience_id where d.project_id=${ctx.projectId} and d.id=${input.deliveryId}`)
  await reconcileCampaignStatus(ctx.database, ctx.projectId, row.campaign_id)
  return delivery(row)
}

export async function listCampaignDeliveries(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ campaignId: z.string().min(1).max(128).optional(), state: z.enum(["queued", "sending", "sent", "delivered", "read", "replied", "failed", "suppressed"]).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.campaignId) predicates.push(sql`campaign_id=${input.campaignId}`)
  if (input.state) predicates.push(sql`state=${input.state}`)
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<DeliveryRow>(sql`select * from build_campaign_deliveries where ${sqlAnd(predicates)} order by id asc limit ${input.limit + 1}`)
  const rows = result.rows.slice(0, input.limit)
  return { items: rows.map(delivery), nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}

type CampaignTarget = {
  contactId: string
  externalConversationId: string
  conversationId: string
  agentId: string
}

function externalConversationIdFromIdentity(identityKey: string, connectionId: string, channel: string) {
  const connectionPrefix = `${connectionId}:`
  if (identityKey.startsWith(connectionPrefix)) return identityKey.slice(connectionPrefix.length)
  const channelPrefix = `${channel}:`
  if (identityKey.startsWith(channelPrefix)) {
    const remainder = identityKey.slice(channelPrefix.length)
    return remainder.startsWith(`${connectionId}:`) ? remainder.slice(connectionPrefix.length) : remainder
  }
  return identityKey
}

async function resolveCampaignTarget(
  ctx: BuildContext,
  campaignValue: ReturnType<typeof campaign>,
  deliveryValue: DeliveryRow,
  connection: CampaignConnection,
): Promise<CampaignTarget> {
  const audience = await ctx.database.execute<{
    contact_id: string
    external_id: string | null
    display_name: string
    email: string | null
    phone: string | null
  }>(sql`
    select a.contact_id,c.external_id,c.display_name,c.email,c.phone
    from build_campaign_audience a
    join build_contacts c on c.project_id=a.project_id and c.id=a.contact_id
    where a.project_id=${ctx.projectId} and a.id=${deliveryValue.audience_id}
    limit 1
  `)
  const contact = ensureRows(audience.rows, "Campaign audience", deliveryValue.audience_id)
  const identity = await ctx.database.execute<{ identity_key: string }>(sql`
    select identity_key
    from build_contact_identities
    where project_id=${ctx.projectId} and contact_id=${contact.contact_id} and channel=${campaignValue.channel}
      and (identity_key like ${`${connection.id}:%`} or metadata_json->>'connectionId'=${connection.id})
    order by case when identity_key like ${`${connection.id}:%`} then 0 else 1 end, updated_at desc,id asc
    limit 1
  `)
  let externalConversationId = identity.rows[0]
    ? externalConversationIdFromIdentity(identity.rows[0].identity_key, connection.id, campaignValue.channel)
    : ""
  if (!externalConversationId && contact.external_id) {
    externalConversationId = externalConversationIdFromIdentity(contact.external_id, connection.id, campaignValue.channel)
  }
  if (!externalConversationId) throw new Error(`Contact '${contact.contact_id}' has no ${campaignValue.channel} identity for campaign delivery.`)

  const metadata = {
    connectionId: connection.id,
    contactId: contact.contact_id,
    campaignId: campaignValue.id,
  }
  const conversation = await ctx.database.execute<{ id: string }>(sql`
    insert into build_conversations
      (id,project_id,agent_id,channel,external_conversation_id,metadata_json,last_message_at)
    values (${operationId("campaign_conversation")},${ctx.projectId},${connection.agent_id},${campaignValue.channel},${externalConversationId},${jsonValue(metadata)},now())
    on conflict (project_id,agent_id,channel,external_conversation_id) where external_conversation_id is not null
    do update set metadata_json=build_conversations.metadata_json || excluded.metadata_json, updated_at=now()
    returning id
  `)
  const conversationId = ensureRows(conversation.rows, "Campaign conversation", externalConversationId).id
  return {
    contactId: contact.contact_id,
    externalConversationId,
    conversationId,
    agentId: connection.agent_id,
  }
}

async function failClaimedCampaignDelivery(
  ctx: BuildContext,
  deliveryId: string,
  error: unknown,
  retryable: boolean,
) {
  const message = (error instanceof Error ? error.message : "Campaign delivery could not be queued.").slice(0, 4_000)
  const nextAttempt = retryable ? new Date(Date.now() + 60_000).toISOString() : null
  const state = retryable ? "queued" : "failed"
  const result = await ctx.database.execute<DeliveryRow>(sql`
    update build_campaign_deliveries
    set state=${state},last_error=${message},next_attempt_at=coalesce(${nextAttempt},next_attempt_at),updated_at=now()
    where project_id=${ctx.projectId} and id=${deliveryId} and state='sending'
    returning *
  `)
  const row = result.rows[0]
  if (row) {
    await ctx.database.execute(sql`
      update build_campaign_audience set state=${state},updated_at=now()
      where project_id=${ctx.projectId} and id=${row.audience_id}
    `)
    await ctx.database.execute(sql`
      insert into build_operation_events(id,project_id,event_type,contact_id,channel,payload_json)
      select ${operationId("event")},${ctx.projectId},'agent_failed',a.contact_id,d.channel,${jsonValue({ deliveryId, error: message, retryable })}
      from build_campaign_deliveries d
      join build_campaign_audience a on a.project_id=d.project_id and a.id=d.audience_id
      where d.project_id=${ctx.projectId} and d.id=${deliveryId}
    `)
    await reconcileCampaignStatus(ctx.database, ctx.projectId, row.campaign_id)
  }
  return { state, error: message }
}

async function guardClaimedCampaignDelivery(
  ctx: BuildContext,
  deliveryId: string,
) {
  const current = await ctx.database.execute<{
    campaign_id: string
    campaign_status: string
    scheduled_at: unknown
    audience_id: string
    audience_state: string
    contact_id: string
    suppression_reason: string | null
  }>(sql`
    select c.id as campaign_id,c.status as campaign_status,c.scheduled_at,a.id as audience_id,
      a.state as audience_state,a.contact_id,active_suppression.reason as suppression_reason
    from build_campaign_deliveries d
    join build_campaigns c on c.project_id=d.project_id and c.id=d.campaign_id
    join build_campaign_audience a on a.project_id=d.project_id and a.id=d.audience_id
    left join lateral (
      select s.reason
      from build_campaign_suppressions s
      where s.project_id=d.project_id and s.contact_id=a.contact_id
        and (s.expires_at is null or s.expires_at>now())
      order by s.created_at desc,s.reason asc
      limit 1
    ) active_suppression on true
    where d.project_id=${ctx.projectId} and d.id=${deliveryId}
    limit 1
  `)
  const row = current.rows[0]
  if (!row) return { allowed: false, retryable: false, error: "Campaign delivery was not found." }
  if (row.suppression_reason) {
    await ctx.database.execute(sql`
      update build_campaign_deliveries set state='suppressed',last_error=${row.suppression_reason},updated_at=now()
      where project_id=${ctx.projectId} and id=${deliveryId} and state='sending'
    `)
    await ctx.database.execute(sql`
      update build_campaign_audience set state='suppressed',suppression_reason=${row.suppression_reason},updated_at=now()
      where project_id=${ctx.projectId} and id=${row.audience_id}
    `)
    await reconcileCampaignStatus(ctx.database, ctx.projectId, row.campaign_id)
    return { allowed: false, retryable: false, error: "Campaign recipient is suppressed." }
  }
  const scheduledAt = row.scheduled_at == null ? null : new Date(String(row.scheduled_at)).getTime()
  if (row.campaign_status !== "running" || (scheduledAt !== null && scheduledAt > Date.now())) {
    await ctx.database.execute(sql`
      update build_campaign_deliveries set state='queued',next_attempt_at=now()+interval '30 seconds',updated_at=now()
      where project_id=${ctx.projectId} and id=${deliveryId} and state='sending'
    `)
    await ctx.database.execute(sql`
      update build_campaign_audience set state='queued',updated_at=now()
      where project_id=${ctx.projectId} and id=${row.audience_id} and state='sending'
    `)
    return { allowed: false, retryable: true, error: row.campaign_status === "paused" ? "Campaign is paused." : "Campaign is not ready for delivery." }
  }
  if (row.audience_state !== "sending" && row.audience_state !== "queued") {
    return { allowed: false, retryable: false, error: "Campaign audience is not eligible for delivery." }
  }
  return { allowed: true, retryable: false as const }
}

export type CampaignDeliveryProcessResult = {
  status: "idle" | "sending" | "failed"
  deliveryId?: string
  campaignId?: string
  connectionId?: string
  conversationId?: string
  messageId?: string
  channelJobId?: string
  deduplicated?: boolean
  retryable?: boolean
  error?: string
}

/**
 * Claims one audience delivery and admits it to the durable channel outbox.
 * Provider I/O remains in processChannelJob; that worker calls the Telegram
 * adapter and reconciles the campaign receipt after the provider responds.
 */
export async function processNextCampaignDelivery(
  context: BuildContext,
  value?: unknown,
): Promise<CampaignDeliveryProcessResult> {
  const ctx = await prepareOperations(context)
  const input = z.object({ limit: z.number().int().min(1).max(1).default(1), connectionId: z.string().trim().min(1).max(128).optional() }).strict().parse(value ?? {})
  const claimed = await claimCampaignDeliveries(ctx, { limit: input.limit })
  const claimedValue = claimed[0]
  if (!claimedValue) return { status: "idle" }
  const deliveryValue = await ctx.database.execute<DeliveryRow>(sql`select * from build_campaign_deliveries where project_id=${ctx.projectId} and id=${claimedValue.id} limit 1`)
  const row = ensureRows(deliveryValue.rows, "Campaign delivery", claimedValue.id)
  try {
    const guard = await guardClaimedCampaignDelivery(ctx, row.id)
    if (!guard.allowed) {
      return {
        status: "failed",
        deliveryId: row.id,
        campaignId: row.campaign_id,
        retryable: guard.retryable,
        error: guard.error,
      }
    }
    const campaignValue = await getCampaign(ctx, row.campaign_id)
    assertOperationsChannelCapability(campaignValue.channel, "campaigns")
    const connection = await resolveCampaignConnection(ctx, campaignValue, input.connectionId)
    const target = await resolveCampaignTarget(ctx, campaignValue, row, connection)
    const contact = await ctx.database.execute<Record<string, unknown>>(sql`select external_id,display_name,email,phone from build_contacts where project_id=${ctx.projectId} and id=${target.contactId}`)
    const text = renderCampaignText(decodeJson<Record<string, unknown>>(row.payload_json, campaignValue.template), ensureRows(contact.rows, "Contact", target.contactId))
    const queued = await enqueueOutboundEnvelope(ctx, {
      connectionId: connection.id,
      conversationId: target.conversationId,
      contactId: target.contactId,
      channel: campaignValue.channel,
      idempotencyKey: `campaign:${row.id}`,
      text,
      metadata: { campaignDeliveryId: row.id, campaignId: campaignValue.id, source: "campaign" },
    }, target.externalConversationId)
    return {
      status: "sending",
      deliveryId: row.id,
      campaignId: campaignValue.id,
      connectionId: connection.id,
      conversationId: target.conversationId,
      messageId: queued.messageId,
      channelJobId: queued.channelJobId,
      deduplicated: queued.deduplicated,
    }
  } catch (error) {
    const retryable = error instanceof Error && /connected|connection|temporar|outbox|database|channel/i.test(error.message)
    const failure = await failClaimedCampaignDelivery(ctx, row.id, error, retryable)
    return {
      status: "failed",
      deliveryId: row.id,
      campaignId: row.campaign_id,
      retryable,
      error: failure.error,
    }
  }
}

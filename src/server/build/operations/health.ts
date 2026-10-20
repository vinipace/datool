import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  safeDeliveryRetryCodeSchema,
  safeDeliveryRetryCodes,
  type BuildDeliveryFailure,
  type BuildHealth,
  type SafeDeliveryRetryCode,
} from "@/src/lib/build/operations"
import type { BuildContext } from "../context"
import { validation } from "@/src/server/tracer/errors"
import {
  ensureRows,
  iso,
  pageCursor,
  prepareOperations,
} from "./database"

/**
 * Failure codes which are safe to show to an operator. Provider responses,
 * request URLs, payloads, and credentials never leave the channel ledger.
 */
const publicFailureCodes = new Set([
  "WHATSAPP_WINDOW_CLOSED", "WHATSAPP_CONSENT_REQUIRED", "WHATSAPP_OPTED_OUT", "WHATSAPP_INVALID_MESSAGE", "WHATSAPP_REJECTED", "WHATSAPP_DISCONNECTED", "PROVIDER_UNAVAILABLE",
  "INVALID_CREDENTIAL",
  "INVALID_WEBHOOK",
  "INVALID_WEBHOOK_SECRET",
  "UNSUPPORTED_ATTACHMENT",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_ERROR",
  "CHANNEL_LEASE_LOST",
  "UNKNOWN",
])

type HealthCountRow = {
  backlog: number | string
  oldest_job_at: unknown
  failed: number | string
  uncertain: number | string
}

function integer(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function queueHealth(row: HealthCountRow | undefined): BuildHealth["queues"]["knowledge"] {
  return {
    backlog: integer(row?.backlog),
    oldestJobAt: iso(row?.oldest_job_at),
    failed: integer(row?.failed),
    uncertain: integer(row?.uncertain),
  }
}

/**
 * Read a bounded, project-scoped view of all durable Build worker queues.
 * Backlog definitions mirror the worker claim/recovery predicates so this is
 * useful for release checks without introducing a second queue abstraction.
 */
export async function getBuildHealth(context: BuildContext): Promise<BuildHealth> {
  const ctx = await prepareOperations(context)
  const [knowledge, channel, simulation, campaign] = await Promise.all([
    ctx.database.execute<HealthCountRow>(sql`
      select
        count(*) filter (
          where status='queued'
             or (status='running' and (lease_expires_at is null or lease_expires_at<=now()))
        )::int as backlog,
        min(queued_at) filter (
          where status='queued'
             or (status='running' and (lease_expires_at is null or lease_expires_at<=now()))
        ) as oldest_job_at,
        count(*) filter (where status='failed')::int as failed,
        0::int as uncertain
      from build_knowledge_jobs
      where project_id=${ctx.projectId}
    `),
    ctx.database.execute<HealthCountRow>(sql`
      select
        count(*) filter (
          where (status='queued' and run_after<=now())
             or (status='running' and (locked_at is null or locked_at<now()-interval '5 minutes'))
        )::int as backlog,
        min(created_at) filter (
          where (status='queued' and run_after<=now())
             or (status='running' and (locked_at is null or locked_at<now()-interval '5 minutes'))
        ) as oldest_job_at,
        count(*) filter (where status='failed')::int as failed,
        count(*) filter (where status='uncertain')::int as uncertain
      from build_channel_job
      where project_id=${ctx.projectId}
    `),
    ctx.database.execute<HealthCountRow>(sql`
      select
        count(*) filter (
          where status='queued'
             or (status='running' and (lease_expires_at is null or lease_expires_at<=now()))
        )::int as backlog,
        min(created_at) filter (
          where status='queued'
             or (status='running' and (lease_expires_at is null or lease_expires_at<=now()))
        ) as oldest_job_at,
        count(*) filter (where status='failed')::int as failed,
        0::int as uncertain
      from build_test_runs
      where project_id=${ctx.projectId}
    `),
    ctx.database.execute<HealthCountRow>(sql`
      with pending as (
        select d.created_at as job_at
        from build_campaign_deliveries d
        join build_campaigns c
          on c.project_id=d.project_id and c.id=d.campaign_id
        where d.project_id=${ctx.projectId}
          and c.status='running'
          and (c.scheduled_at is null or c.scheduled_at<=now())
          and (
            (d.state='queued' and d.next_attempt_at<=now())
            or (d.state='sending' and d.updated_at<now()-interval '5 minutes')
          )
        union all
        select c.scheduled_at as job_at
        from build_campaigns c
        where c.project_id=${ctx.projectId}
          and c.status='scheduled'
          and c.scheduled_at is not null
          and c.scheduled_at<=now()
      )
      select
        (select count(*)::int from pending) as backlog,
        (select min(job_at) from pending) as oldest_job_at,
        (
          (select count(*) from build_campaign_deliveries where project_id=${ctx.projectId} and state='failed')
          + (select count(*) from build_campaigns where project_id=${ctx.projectId} and status='failed')
        )::int as failed,
        0::int as uncertain
    `),
  ])

  const queues = {
    knowledge: queueHealth(knowledge.rows[0]),
    channel: queueHealth(channel.rows[0]),
    simulation: queueHealth(simulation.rows[0]),
    campaign: queueHealth(campaign.rows[0]),
  }
  const totalBacklog = Object.values(queues).reduce((sum, queue) => sum + queue.backlog, 0)
  const totalFailed = Object.values(queues).reduce((sum, queue) => sum + queue.failed, 0)
  const totalUncertain = Object.values(queues).reduce((sum, queue) => sum + queue.uncertain, 0)

  return {
    projectId: ctx.projectId,
    generatedAt: new Date().toISOString(),
    status: totalUncertain > 0 ? "blocked" : totalBacklog > 0 || totalFailed > 0 ? "degraded" : "healthy",
    totalBacklog,
    totalFailed,
    totalUncertain,
    queues,
  }
}

const deliveryFailureInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(256).optional(),
  status: z.enum(["failed", "uncertain", "all"]).default("all"),
}).strict()

type DeliveryFailureRow = {
  job_id: string
  message_id: string | null
  connection_id: string
  kind: string
  channel: string | null
  job_status: string
  attempts: number | string
  run_after: unknown
  job_created_at: unknown
  job_updated_at: unknown
  message_status: string | null
  direction: string | null
  provider_message_id: string | null
  error_code: string | null
}

function publicFailureCode(value: string | null) {
  return value && publicFailureCodes.has(value) ? value : "UNKNOWN"
}

function failureModel(row: DeliveryFailureRow): BuildDeliveryFailure {
  const status = row.job_status === "uncertain" ? "uncertain" : "failed"
  const failureCode = publicFailureCode(row.error_code)
  const retryAllowed =
    status === "failed" &&
    row.kind === "deliver_outbound" &&
    row.message_status === "failed" &&
    row.direction === "outbound" &&
    row.provider_message_id === null &&
    safeDeliveryRetryCodes.includes(failureCode as SafeDeliveryRetryCode)
  return {
    jobId: row.job_id,
    messageId: row.message_id,
    connectionId: row.connection_id,
    kind: row.kind as BuildDeliveryFailure["kind"],
    channel: row.channel,
    status,
    attempts: integer(row.attempts),
    runAfter: iso(row.run_after),
    createdAt: iso(row.job_created_at),
    updatedAt: iso(row.job_updated_at),
    messageStatus: row.message_status,
    direction: row.direction,
    failureCode,
    retryAllowed,
  }
}

/** List only bounded, sanitized failure metadata from the channel ledger. */
export async function listDeliveryFailures(
  context: BuildContext,
  value?: unknown,
): Promise<{ items: BuildDeliveryFailure[]; nextCursor: string | null }> {
  const ctx = await prepareOperations(context)
  const input = deliveryFailureInputSchema.parse(value ?? {})
  const cursor = pageCursor(input.cursor)
  const statusFilter = input.status === "all"
    ? sql`j.status in ('failed','uncertain')`
    : sql`j.status=${input.status}`
  const cursorFilter = cursor ? sql`and j.id::text>${cursor}` : sql``
  const result = await ctx.database.execute<DeliveryFailureRow>(sql`
    select
      j.id::text as job_id,
      j.message_id,
      j.connection_id::text as connection_id,
      j.kind,
      c.channel,
      j.status as job_status,
      j.attempts,
      j.run_after,
      j.created_at as job_created_at,
      j.updated_at as job_updated_at,
      m.status as message_status,
      m.direction,
      m.provider_message_id,
      m.error_code
    from build_channel_job j
    join build_channel_connection c
      on c.project_id=j.project_id and c.id=j.connection_id
    left join build_channel_message m
      on m.project_id=j.project_id and m.id=j.message_id
    where j.project_id=${ctx.projectId}
      and ${statusFilter}
      ${cursorFilter}
    order by j.id asc
    limit ${input.limit + 1}
  `)
  const rows = result.rows.slice(0, input.limit)
  return {
    items: rows.map(failureModel),
    nextCursor: result.rows.length > input.limit ? rows.at(-1)?.job_id ?? null : null,
  }
}

const retryDeliveryInputSchema = z.object({
  jobId: z.string().uuid(),
  expectedCode: safeDeliveryRetryCodeSchema,
}).strict()

type RetryRow = {
  job_id: string
  message_id: string
  job_status: string
  kind: string
  message_status: string
  direction: string
  provider_message_id: string | null
  error_code: string | null
  campaign_delivery_id: string | null
  campaign_audience_id: string | null
}

/**
 * Requeue one known pre-send failure after an explicit operator action. A
 * provider id or an uncertain status is a hard stop because the message may
 * already have been delivered.
 */
export async function retryDelivery(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = retryDeliveryInputSchema.parse(value)
  return ctx.database.transaction(async (tx) => {
    const result = await tx.execute<RetryRow>(sql`
      select
        j.id::text as job_id,
        j.message_id,
        j.status as job_status,
        j.kind,
        m.status as message_status,
        m.direction,
        m.provider_message_id,
        m.error_code,
        m.content_json->'metadata'->>'campaignDeliveryId' as campaign_delivery_id,
        d.audience_id as campaign_audience_id
      from build_channel_job j
      join build_channel_message m
        on m.project_id=j.project_id and m.id=j.message_id
      left join build_campaign_deliveries d
        on d.project_id=j.project_id
       and d.id=m.content_json->'metadata'->>'campaignDeliveryId'
      where j.project_id=${ctx.projectId}
        and j.id=${input.jobId}::uuid
      for update of j, m
    `)
    const row = ensureRows(result.rows, "Channel delivery job", input.jobId)
    if (row.job_status === "uncertain") {
      throw validation("This delivery outcome is uncertain and cannot be retried automatically.")
    }
    if (row.job_status !== "failed") {
      throw validation("Only a terminal failed delivery can be retried.")
    }
    if (row.kind !== "deliver_outbound" || !row.message_id || row.direction !== "outbound") {
      throw validation("Only failed outbound deliveries can be retried.")
    }
    if (row.message_status !== "failed") {
      throw validation("The channel message is not a terminal failed delivery.")
    }
    if (row.provider_message_id !== null) {
      throw validation("A delivery with a provider message id cannot be retried safely.")
    }
    if (row.error_code !== input.expectedCode) {
      throw validation("The expected pre-send failure code does not match this delivery.")
    }

    if (row.campaign_delivery_id && row.campaign_audience_id) {
      const suppressed = await tx.execute(sql`
        select 1
        from build_campaign_deliveries d
        join build_campaign_suppressions s
          on s.project_id=d.project_id
         and s.contact_id=(select contact_id from build_campaign_audience where project_id=d.project_id and id=d.audience_id)
        where d.project_id=${ctx.projectId}
          and d.id=${row.campaign_delivery_id}
          and (s.expires_at is null or s.expires_at>now())
        limit 1
      `)
      if (suppressed.rows[0]) {
        throw validation("The campaign recipient is currently suppressed and cannot be retried.")
      }
    }

    const updated = await tx.execute(sql`
      update build_channel_job
      set status='queued',attempts=0,run_after=now(),locked_at=null,lock_token=null,last_error=null,updated_at=now()
      where project_id=${ctx.projectId} and id=${input.jobId}::uuid and status='failed'
    `)
    if (!updated.rowCount) throw validation("The channel delivery changed before it could be retried.")
    await tx.execute(sql`
      update build_channel_message
      set status='queued',error_code=null,error_message=null,updated_at=now()
      where project_id=${ctx.projectId} and id=${row.message_id} and status='failed' and provider_message_id is null
    `)
    if (row.campaign_delivery_id && row.campaign_audience_id) {
      await tx.execute(sql`
        update build_campaign_deliveries
        set state='queued',last_error=null,next_attempt_at=now(),updated_at=now()
        where project_id=${ctx.projectId} and id=${row.campaign_delivery_id} and state='failed' and provider_message_id is null
      `)
      await tx.execute(sql`
        update build_campaign_audience
        set state='queued',updated_at=now()
        where project_id=${ctx.projectId} and id=${row.campaign_audience_id} and state='failed'
      `)
    }
    return {
      projectId: ctx.projectId,
      jobId: row.job_id,
      messageId: row.message_id,
      status: "queued" as const,
      retryAllowed: true as const,
    }
  })
}

import { sql } from "drizzle-orm"
import { z } from "zod"

import { operationEventInputSchema } from "@/src/lib/build/contracts"
import type { ImportedScore } from "@/src/lib/tracer/imported-scores"
import { scopedTracerTransaction } from "@/src/server/tracer/db"
import { validation } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import { operationId } from "../context"
import { decodeJson, iso, jsonValue, prepareOperations, sqlAnd } from "./database"

export async function recordOperationEvent(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = operationEventInputSchema.strict().parse(value)
  const id = operationId("event")
  await ctx.database.execute(sql`
    insert into build_operation_events(id,project_id,event_type,conversation_id,contact_id,channel,payload_json,occurred_at)
    values (${id},${ctx.projectId},${input.eventType},${input.conversationId ?? null},${input.contactId ?? null},${input.channel ?? null},${jsonValue(input.payload)},coalesce(${input.occurredAt ?? null},now()))
  `)
  return { id, projectId: ctx.projectId, ...input, occurredAt: input.occurredAt ?? new Date().toISOString() }
}

export async function recordFeedback(context: BuildContext, value: unknown) {
  const input = z
    .object({
      conversationId: z.string().max(256).optional(),
      messageId: z.string().min(1).max(256).optional(),
      contactId: z.string().max(128).optional(),
      channel: z.string().max(80).optional(),
      question: z.string().trim().min(1).max(4_000),
      sentiment: z.enum(["positive", "negative", "unknown"]).default("unknown"),
      reason: z.string().max(500).optional(),
      metadata: z.record(z.string(), z.json()).default({}),
    })
    .strict()
    .parse(value)
  const ctx = await prepareOperations(context)
  // Retain compatibility with existing preview clients. Never accept a trace
  // identity from metadata: only the persisted message-to-turn link is trusted.
  const messageId =
    input.messageId ??
    (typeof input.metadata.messageId === "string"
      ? input.metadata.messageId
      : undefined)
  if (messageId && !input.conversationId)
    throw validation("A conversation is required for message feedback.")
  return ctx.database.transaction(async (tx) => {
    let target:
      | { message_id: string | null; trace_id: string | null; channel: string }
      | undefined
    if (messageId) {
      const found = await tx.execute<{
        message_id: string | null
        trace_id: string | null
        channel: string
      }>(sql`
        SELECT m.id AS message_id, t.trace_id, c.channel
        FROM build_conversation_messages m
        JOIN build_conversations c ON c.project_id=m.project_id AND c.id=m.conversation_id
        LEFT JOIN build_conversation_turns t ON t.project_id=m.project_id AND t.id=m.turn_id AND t.conversation_id=m.conversation_id
        WHERE m.project_id=${ctx.projectId} AND m.conversation_id=${input.conversationId}
          AND m.id=${messageId} AND m.role='assistant'
        UNION ALL
        SELECT r.id AS message_id, t.trace_id, c.channel
        FROM build_channel_message m
        JOIN build_conversations c ON c.project_id=m.project_id AND c.id=m.conversation_id
        LEFT JOIN build_conversation_messages r ON r.project_id=m.project_id AND r.id=m.runtime_message_id AND r.conversation_id=m.conversation_id AND r.role='assistant'
        LEFT JOIN build_conversation_turns t ON t.project_id=r.project_id AND t.id=r.turn_id AND t.conversation_id=r.conversation_id
        WHERE m.project_id=${ctx.projectId} AND m.conversation_id=${input.conversationId}
          AND m.id=${messageId} AND m.direction='outbound'
        LIMIT 1
      `)
      target = found.rows[0]
      if (!target)
        throw validation("Message is not available in this conversation.")
    }
    const traceId = target?.trace_id ?? null
    const channel = target?.channel ?? input.channel
    const event = await recordOperationEvent(
      { ...ctx, database: scopedTracerTransaction(ctx.database, tx) },
      {
        eventType:
          input.sentiment === "negative" ? "low_feedback" : "message_received",
        conversationId: input.conversationId,
        contactId: input.contactId,
        channel,
        payload: {
          ...input.metadata,
          question: input.question,
          sentiment: input.sentiment,
          reason: input.reason ?? null,
          messageId: messageId ?? null,
          runtimeMessageId: target?.message_id ?? null,
          traceId,
        },
      }
    )
    let scoreId: string | null = null
    if (traceId && target?.message_id) {
      const score: ImportedScore = {
        name: "Customer feedback",
        timestamp: event.occurredAt,
        target: { type: "trace", id: traceId },
        data: {
          type: "categorical",
          value:
            input.sentiment === "positive"
              ? "Helpful"
              : input.sentiment === "negative"
                ? "Not helpful"
                : "Unrated",
        },
        source: {
          provider: "datool-build",
          instance: "build",
          projectId: ctx.projectId,
          id: target.message_id,
        },
        author: ctx.actorId
          ? { type: "operator", id: ctx.actorId }
          : { type: "customer" },
        ...(input.reason ? { comment: input.reason } : {}),
        metadata: {
          source: "customer-feedback",
          conversationId: input.conversationId!,
          messageId: target.message_id,
          channelMessageId: messageId === target.message_id ? null : messageId!,
          channel: channel ?? null,
          feedbackEventId: event.id,
        },
      }
      scoreId = `score_feedback:${target.message_id}`
      // One current rating per canonical response, shared by preview and embed.
      // The operation ledger above retains each change, atomically with this score.
      await tx.execute(sql`
        INSERT INTO scores(id,project_id,trace_id,feedback_key,name,value,status,created_at,external_json)
        VALUES (${scoreId},${ctx.projectId},${traceId},${`build-message:${target.message_id}`},${score.name},null,'ok',${score.timestamp},${jsonValue(score)})
        ON CONFLICT (project_id,feedback_key) DO UPDATE SET
          external_json=excluded.external_json, created_at=excluded.created_at
      `)
    }
    return { ...event, traceId, scoreId }
  })
}

type EventCountRow = { event_type: string; count: number; contacts: number; conversations: number }
type ChannelCountRow = { channel: string | null; count: number }

export async function getOperationalAnalytics(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict().parse(value ?? {})
  const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 86_400_000)
  const to = input.to ? new Date(input.to) : new Date()
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error("Analytics range must contain valid from and to dates.")
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new Error("Analytics range cannot exceed 366 days.")
  const [events, channels, tickets, csat, conversations] = await Promise.all([
    ctx.database.execute<EventCountRow>(sql`select event_type,count(*)::int as count,count(distinct contact_id)::int as contacts,count(distinct conversation_id)::int as conversations from build_operation_events where project_id=${ctx.projectId} and occurred_at>=${from.toISOString()} and occurred_at<${to.toISOString()} group by event_type order by event_type asc`),
    ctx.database.execute<ChannelCountRow>(sql`select channel,count(*)::int as count from build_operation_events where project_id=${ctx.projectId} and occurred_at>=${from.toISOString()} and occurred_at<${to.toISOString()} group by channel order by count desc`),
    ctx.database.execute<{ status: string; count: number; avg_first_response_seconds: number | null }>(sql`select status,count(*)::int as count,avg(extract(epoch from (first_response_at-created_at)))::float as avg_first_response_seconds from build_inbox_tickets where project_id=${ctx.projectId} and created_at>=${from.toISOString()} and created_at<${to.toISOString()} group by status order by status asc`),
    ctx.database.execute<{ responses: number; average: number | null; positive: number; negative: number }>(sql`select count(*) filter (where status='answered')::int as responses,avg(rating)::float as average,count(*) filter (where rating>=4)::int as positive,count(*) filter (where rating<=2)::int as negative from build_csat_surveys where project_id=${ctx.projectId} and requested_at>=${from.toISOString()} and requested_at<${to.toISOString()}`),
    ctx.database.execute<{ conversations: number; contacts: number }>(sql`select count(distinct conversation_id)::int as conversations,count(distinct contact_id)::int as contacts from build_operation_events where project_id=${ctx.projectId} and occurred_at>=${from.toISOString()} and occurred_at<${to.toISOString()}`),
  ])
  return {
    projectId: ctx.projectId,
    from: from.toISOString(),
    to: to.toISOString(),
    conversations: conversations.rows[0]?.conversations ?? 0,
    contacts: conversations.rows[0]?.contacts ?? 0,
    eventsByType: events.rows.map((row) => ({ eventType: row.event_type, count: row.count, contacts: row.contacts, conversations: row.conversations })),
    eventsByChannel: channels.rows.map((row) => ({ channel: row.channel, count: row.count })),
    ticketsByStatus: tickets.rows.map((row) => ({ status: row.status, count: row.count, averageFirstResponseSeconds: row.avg_first_response_seconds })),
    csat: { responses: csat.rows[0]?.responses ?? 0, average: csat.rows[0]?.average ?? null, positive: csat.rows[0]?.positive ?? 0, negative: csat.rows[0]?.negative ?? 0 },
  }
}

type GapAggregateRow = { question: string; evidence_count: number; negative_count: number; sample_event_ids: string[]; latest_at: unknown }
type GapRow = { id: string; project_id: string; fingerprint: string; question: string; evidence_count: number; negative_count: number; sample_event_ids: unknown; status: string; created_at: unknown; updated_at: unknown }
function gap(row: GapRow) { return { id: row.id, projectId: row.project_id, fingerprint: row.fingerprint, question: row.question, evidenceCount: row.evidence_count, negativeCount: row.negative_count, sampleEventIds: decodeJson<string[]>(row.sample_event_ids, []), status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } }

/** Recomputes suggestions from actual failure/negative-feedback evidence. */
export async function refreshKnowledgeGapSuggestions(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ limit: z.number().int().min(1).max(100).default(100) }).strict().parse(value ?? {})
  const result = await ctx.database.execute<GapAggregateRow>(sql`
    select payload_json->>'question' as question,
           count(*)::int as evidence_count,
           count(*) filter (where event_type in ('agent_failed','tool_failed','low_feedback'))::int as negative_count,
           array_agg(id order by occurred_at desc) as sample_event_ids,
           max(occurred_at) as latest_at
    from build_operation_events
    where project_id=${ctx.projectId}
      and event_type in ('agent_failed','tool_failed','low_feedback')
      and coalesce(nullif(trim(payload_json->>'question'),''),'')<>''
    group by payload_json->>'question'
    order by negative_count desc,evidence_count desc,question asc
    limit ${input.limit}
  `)
  for (const row of result.rows) {
    const question = row.question.trim().replace(/\s+/g, " ")
    const fingerprint = await digestFingerprint(question)
    const samples = (row.sample_event_ids ?? []).slice(0, 10)
    await ctx.database.execute(sql`
      insert into build_knowledge_gap_suggestions(id,project_id,fingerprint,question,evidence_count,negative_count,sample_event_ids)
      values (${operationId("gap")},${ctx.projectId},${fingerprint},${question},${row.evidence_count},${row.negative_count},${jsonValue(samples)})
      on conflict (project_id,fingerprint) do update set question=excluded.question,evidence_count=excluded.evidence_count,negative_count=excluded.negative_count,sample_event_ids=excluded.sample_event_ids,updated_at=now()
    `)
  }
  return listKnowledgeGapSuggestions(ctx, { limit: input.limit })
}

async function digestFingerprint(value: string) {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value.toLocaleLowerCase())
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("")
  }
  return value.toLocaleLowerCase().slice(0, 128)
}

export async function listKnowledgeGapSuggestions(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ status: z.enum(["open", "ignored", "resolved"]).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.status) predicates.push(sql`status=${input.status}`)
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<GapRow>(sql`select * from build_knowledge_gap_suggestions where ${sqlAnd(predicates)} order by negative_count desc,evidence_count desc,id asc limit ${input.limit + 1}`)
  const rows = result.rows.slice(0, input.limit)
  return { items: rows.map(gap), nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}

export async function updateKnowledgeGapStatus(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ id: z.string().min(1).max(128), status: z.enum(["open", "ignored", "resolved"]) }).strict().parse(value)
  const result = await ctx.database.execute(sql`update build_knowledge_gap_suggestions set status=${input.status},updated_at=now() where project_id=${ctx.projectId} and id=${input.id}`)
  if (!result.rowCount) throw new Error(`Knowledge-gap suggestion '${input.id}' was not found.`)
  return { id: input.id, projectId: ctx.projectId, status: input.status }
}

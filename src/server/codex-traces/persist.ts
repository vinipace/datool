import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import type { CodexSnapshot } from "@/src/lib/codex-traces/types"
import type { JsonObject } from "@/src/lib/tracer/contracts"
import { getTracerProjectId, type TracerDatabase } from "../tracer/db"
import { parseCreateSession, parseCreateTrace } from "../tracer/validation"
import { TracerError, validation } from "../tracer/errors"

const sourceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const envelope = z
  .object({
    version: z.literal(1),
    capturedAt: z.string().datetime({ offset: true }),
    threadId: sourceId,
    turnId: sourceId,
    session: z.object({
      name: z.string().max(200),
      createdAt: z.string().datetime({ offset: true }),
      attributes: z.record(z.string(), z.unknown()),
    }),
    trace: z.unknown(),
  })
  .strict()

export function parseCodexSnapshot(value: unknown): CodexSnapshot {
  const result = envelope.safeParse(value)
  if (!result.success) throw validation("Invalid Codex trace snapshot")
  const session = parseCreateSession({
    name: result.data.session.name,
    attributes: result.data.session.attributes,
  })
  const trace = parseCreateTrace(result.data.trace)
  if (
    !trace.name ||
    !trace.startedAt ||
    trace.id ||
    trace.sessionId ||
    trace.operation !== "codex.turn"
  )
    throw validation(
      "Codex snapshot requires a source trace, not destination IDs"
    )
  const spans = trace.spans ?? []
  const ids = new Set(spans.map((s) => s.id))
  if (ids.size !== spans.length || ids.has(undefined))
    throw validation("Codex spans require unique source IDs")
  const parents = new Map(spans.map((s) => [s.id, s.parentId]))
  for (const span of spans) {
    if (!span.startedAt)
      throw validation("Codex spans require source timestamps")
    if (span.endedAt && Date.parse(span.endedAt) < Date.parse(span.startedAt))
      throw validation("Codex span ends before it starts")
    const seen = new Set([span.id])
    let parent = span.parentId
    while (parent) {
      if (!ids.has(parent) || seen.has(parent))
        throw validation("Codex span hierarchy is incomplete or cyclic")
      seen.add(parent)
      parent = parents.get(parent)
    }
  }
  if (trace.endedAt && Date.parse(trace.endedAt) < Date.parse(trace.startedAt))
    throw validation("Codex turn ends before it starts")
  return {
    ...result.data,
    session: { ...result.data.session, attributes: session.attributes ?? {} },
    trace,
  } as CodexSnapshot
}

export function codexDestinationId(
  projectId: string,
  kind: string,
  ...source: string[]
) {
  return `codex_${kind}_${createHash("sha256")
    .update(JSON.stringify([projectId, ...source]))
    .digest("hex")
    .slice(0, 40)}`
}

/** Atomic, idempotent snapshots. A 200 response proves PostgreSQL commit, including all spans. */
export async function persistCodexSnapshot(
  database: TracerDatabase,
  snapshot: CodexSnapshot
) {
  const projectId = getTracerProjectId(database)
  const traceId = codexDestinationId(
    projectId,
    "turn",
    snapshot.threadId,
    snapshot.turnId
  )
  const sessionId = codexDestinationId(projectId, "session", snapshot.threadId)
  const source = {
    source: "codex",
    "codex.thread_id": snapshot.threadId,
    "codex.turn_id": snapshot.turnId,
  }
  const trace = snapshot.trace
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${traceId},0))`
    )
    const previous = await tx.execute<{
      project_id: string
      attributes_json: JsonObject
      status: string
    }>(
      sql`select project_id,attributes_json,status from traces where id=${traceId}`
    )
    const prior = previous.rows[0]
    if (
      prior &&
      (prior.project_id !== projectId ||
        prior.attributes_json["source"] !== "codex" ||
        prior.attributes_json["codex.thread_id"] !== snapshot.threadId ||
        prior.attributes_json["codex.turn_id"] !== snapshot.turnId)
    )
      throw new TracerError(
        "CONFLICT",
        "Codex destination ID is already owned by another source"
      )
    const priorTime = Date.parse(
      String(prior?.attributes_json["codex.capture.updated_at"] ?? "")
    )
    if (
      Number.isFinite(priorTime) &&
      priorTime >= Date.parse(snapshot.capturedAt)
    )
      return {
        traceId,
        sessionId,
        status: "unchanged",
        spanCount: trace.spans.length,
      }
    // A delayed partial export must not turn a finished trace back into a running one.
    if (prior && prior.status !== "running" && trace.status === "running")
      return {
        traceId,
        sessionId,
        status: "unchanged",
        spanCount: trace.spans.length,
      }
    // A new collector without the old journal must not erase richer captured evidence.
    const incoming = trace.attributes ?? {}
    if (
      prior &&
      ((prior.attributes_json["codex.telemetry.coverage"] === "otel_turn" &&
        incoming["codex.telemetry.coverage"] !== "otel_turn") ||
        (prior.attributes_json["codex.usage.reconciliation"] === "matched" &&
          incoming["codex.usage.reconciliation"] !== "matched") ||
        (String(prior.attributes_json["codex.history.coverage"]).startsWith(
          "recorded_items"
        ) &&
          !String(incoming["codex.history.coverage"]).startsWith(
            "recorded_items"
          )))
    )
      return {
        traceId,
        sessionId,
        status: "unchanged",
        spanCount: trace.spans.length,
      }
    const attrs = {
      ...(prior?.attributes_json ?? {}),
      ...trace.attributes,
      ...source,
      "codex.capture.updated_at": snapshot.capturedAt,
    }
    const sessionAttrs = JSON.stringify({
      ...snapshot.session.attributes,
      source: "codex",
      "codex.thread_id": snapshot.threadId,
    })
    const existingSession = await tx.execute<{
      project_id: string
      attributes_json: string
    }>(
      sql`select project_id,attributes_json from sessions where id=${sessionId}`
    )
    if (
      existingSession.rows[0] &&
      (existingSession.rows[0].project_id !== projectId ||
        JSON.parse(existingSession.rows[0].attributes_json)[
          "codex.thread_id"
        ] !== snapshot.threadId)
    )
      throw new TracerError("CONFLICT", "Codex session ID collision")
    await tx.execute(sql`insert into sessions(id,project_id,name,attributes_json,created_at,updated_at)
      values(${sessionId},${projectId},${snapshot.session.name},${sessionAttrs},${snapshot.session.createdAt},${snapshot.capturedAt})
      on conflict(id) do update set name=excluded.name, updated_at=greatest(sessions.updated_at,excluded.updated_at)`)
    await tx.execute(sql`insert into traces(id,project_id,session_id,name,operation,group_type,group_name,group_version,input_json,output_json,attributes_json,status,started_at,ended_at)
      values(${traceId},${projectId},${sessionId},${trace.name},'codex.turn','agent','Codex',${trace.group?.version ?? null},${JSON.stringify(trace.input ?? null)},${JSON.stringify(trace.output ?? null)},${JSON.stringify(attrs)}::jsonb,${trace.status ?? "running"},${trace.startedAt},${trace.endedAt ?? null})
      on conflict(id) do update set name=excluded.name,input_json=excluded.input_json,output_json=excluded.output_json,attributes_json=excluded.attributes_json,status=excluded.status,started_at=excluded.started_at,ended_at=excluded.ended_at`)
    // Parent-first insertion works with the existing immediate foreign-key contract.
    const pending = [...trace.spans],
      inserted = new Set<string>()
    while (pending.length) {
      const index = pending.findIndex(
        (s) => !s.parentId || inserted.has(s.parentId)
      )
      if (index < 0) throw validation("Codex span hierarchy cannot be ordered")
      const [span] = pending.splice(index, 1)
      const id = codexDestinationId(
        projectId,
        "span",
        snapshot.threadId,
        snapshot.turnId,
        span.id
      )
      const parentId = span.parentId
        ? codexDestinationId(
            projectId,
            "span",
            snapshot.threadId,
            snapshot.turnId,
            span.parentId
          )
        : null
      const collision = await tx.execute<{
        project_id: string
        trace_id: string
      }>(sql`select project_id,trace_id from spans where id=${id}`)
      if (
        collision.rows[0] &&
        (collision.rows[0].project_id !== projectId ||
          collision.rows[0].trace_id !== traceId)
      )
        throw new TracerError("CONFLICT", "Codex span ID collision")
      await tx.execute(sql`insert into spans(id,project_id,trace_id,parent_id,name,kind,input_json,output_json,attributes_json,status,started_at,ended_at)
        values(${id},${projectId},${traceId},${parentId},${span.name},${span.kind ?? "custom"},${JSON.stringify(span.input ?? null)},${JSON.stringify(span.output ?? null)},${JSON.stringify({ ...span.attributes, ...source, "codex.source_span_id": span.id })}::jsonb,${span.status ?? "running"},${span.startedAt},${span.endedAt ?? null})
        on conflict(id) do update set parent_id=excluded.parent_id,name=excluded.name,kind=excluded.kind,input_json=excluded.input_json,output_json=excluded.output_json,attributes_json=excluded.attributes_json,status=excluded.status,started_at=excluded.started_at,ended_at=excluded.ended_at`)
      inserted.add(span.id)
    }
    return {
      traceId,
      sessionId,
      status: "saved",
      spanCount: trace.spans.length,
    }
  })
}

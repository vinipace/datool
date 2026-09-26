import { sql } from "drizzle-orm"
import type { Span, TraceForEvaluation } from "@/src/lib/tracer/contracts"
import { getTracerProjectId, scopedTracerTransaction, type TracerDatabase } from "./db"
import { notFound, TracerError, validation } from "./errors"
import { assertRelationBytes } from "./read-size"

export const SPAN_EVIDENCE_MAX_BYTES = 1024 * 1024

/** Read only the selected subtree, even when the parent contains huge unrelated payloads. */
export async function captureSpanEvidence(
  db: TracerDatabase,
  traceId: string,
  spanId: string
): Promise<TraceForEvaluation> {
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '10s'`)
    return captureSpanEvidenceSnapshot(scopedTracerTransaction(db, tx), traceId, spanId)
  }, { isolationLevel: "repeatable read" })
}

async function captureSpanEvidenceSnapshot(
  db: TracerDatabase,
  traceId: string,
  spanId: string
): Promise<TraceForEvaluation> {
  const project = getTracerProjectId(db)
  const traceRelation = sql`select id,session_id as "sessionId",started_at as "startedAt",ended_at as "endedAt",attributes_json::jsonb as attributes from traces where project_id=${project} and id=${traceId}`
  await assertRelationBytes(db, traceRelation)
  const trace = await db.execute<
    NonNullable<TraceForEvaluation["provenance"]>["trace"] & {
      sessionId: string | null
    }
  >(traceRelation)
  if (!trace.rows[0]) throw notFound("Trace", traceId)
  const ancestorsRelation = sql`with recursive ancestors(id,parent_id) as (
    select id,parent_id from spans where project_id=${project} and trace_id=${traceId} and id=${spanId}
    union select s.id,s.parent_id from spans s join ancestors a on a.parent_id=s.id where s.project_id=${project} and s.trace_id=${traceId}
  ) select s.id,s.parent_id as "parentId",s.name,s.kind,s.started_at as "startedAt",s.ended_at as "endedAt",s.attributes_json::jsonb as attributes
    from spans s join ancestors a on a.id=s.id where s.project_id=${project} and s.trace_id=${traceId}`
  await assertRelationBytes(db, ancestorsRelation)
  const ancestors =
    await db.execute<
      NonNullable<TraceForEvaluation["provenance"]>["ancestors"][number]
    >(ancestorsRelation)
  if (
    ancestors.rows.some(
      (row) =>
        row.kind === "score" ||
        row.attributes["datool.scorer.execution"] === true
    )
  )
    throw validation(
      "Scorer execution spans and their descendants cannot become production cases."
    )
  // UNION (not UNION ALL) also bounds malformed cyclic parent links.
  const subtree = sql`with recursive selected(id) as (
    select id from spans where project_id=${project} and trace_id=${traceId} and id=${spanId}
      and kind <> 'score' and coalesce(attributes_json::jsonb->>'datool.scorer.execution','false') <> 'true'
    union
    select s.id from spans s join selected p on s.parent_id=p.id
      where s.project_id=${project} and s.trace_id=${traceId} and s.kind <> 'score'
        and coalesce(s.attributes_json::jsonb->>'datool.scorer.execution','false') <> 'true'
  )`
  const size = await db.execute<{ count: number; bytes: number }>(sql`${subtree}
    select count(*)::int as count, coalesce(sum(octet_length(row_to_json(s)::text)),0)::bigint as bytes
    from spans s join selected on selected.id=s.id where s.project_id=${project} and s.trace_id=${traceId}`)
  if (!size.rows[0]?.count)
    throw validation(
      "Selected span is missing, belongs to another trace/project, or is scorer execution evidence."
    )
  if (
    size.rows[0].count > 1000 ||
    Number(size.rows[0].bytes) > SPAN_EVIDENCE_MAX_BYTES
  )
    throw new TracerError(
      "READ_RESULT_TOO_LARGE",
      "Selected span evidence exceeds 1 MiB or 1,000 spans; select a narrower invocation."
    )
  const result = await db.execute<Span>(sql`${subtree}
    select s.id, s.trace_id as "traceId", s.parent_id as "parentId", s.name, s.kind, s.status,
      s.started_at as "startedAt", s.ended_at as "endedAt",
      case when s.group_name is not null then jsonb_build_object('type',s.group_type,'name',s.group_name,'version',s.group_version) end as "group",
      case when s.ended_at_ms >= s.started_at_ms then s.ended_at_ms-s.started_at_ms else null end as "durationMs",
      s.input_json::jsonb as input, s.output_json::jsonb as output, s.attributes_json::jsonb as attributes
    from spans s join selected on selected.id=s.id where s.project_id=${project} and s.trace_id=${traceId}
    order by s.started_at, s.id`)
  const span = result.rows.find((row) => row.id === spanId)!
  if (span.status === "running" || !span.endedAt)
    throw validation(
      "Wait for the selected span to finish before promoting it."
    )
  const evidence: TraceForEvaluation = {
    id: traceId,
    selectedSpanId: spanId,
    group: span.group,
    sessionId: trace.rows[0].sessionId,
    name: span.name,
    operation: span.kind,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    input: span.input,
    output: span.output,
    attributes: span.attributes,
    spans: result.rows,
    provenance: {
      trace: {
        id: traceId,
        startedAt: trace.rows[0].startedAt,
        endedAt: trace.rows[0].endedAt,
        attributes: trace.rows[0].attributes,
      },
      ancestors: ancestors.rows.filter((row) => row.id !== spanId),
    },
  }
  if (Buffer.byteLength(JSON.stringify(evidence)) > SPAN_EVIDENCE_MAX_BYTES)
    throw new TracerError(
      "READ_RESULT_TOO_LARGE",
      "Selected span evidence exceeds 1 MiB; select a narrower invocation."
    )
  return evidence
}

import { sql } from "drizzle-orm"
import { parseCreateSpan, parseCreateTrace } from "../../tracer/validation"
import {
  getTracerProjectId,
  scopedTracerTransaction,
  type TracerDatabase,
} from "../../tracer/db"
import { runTracerEffect } from "../../tracer/effect"
import { createImportedScoreService } from "../../tracer/imported-scores"
import { TracerError } from "../../tracer/errors"
import { SourceError } from "./client"
import {
  attributes,
  io,
  object,
  observationKind,
  scoreEnvelope,
  text,
  time,
} from "./mapper"
import { destinationId, kinds, type ImportRun, type Staged } from "./store"

/** Reconstruct containers only when the source did not supply an original record. */
export async function deriveContainers(db: TracerDatabase, run: ImportRun) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`with roots as (
      select distinct on (raw->>'traceId') raw->>'traceId' as id, raw
      from langfuse_import_records where run_id=${run.id} and kind='observations' and status='pending' and nullif(raw->>'traceId','') is not null
      order by raw->>'traceId', (nullif(raw->>'parentObservationId','') is null) desc, datool_timestamp_ms(raw->>'startTime') nulls last, source_id
    ), times as (
      select raw->>'traceId' as id,to_timestamp(min(datool_timestamp_ms(raw->>'startTime'))/1000) as started,
        case when bool_and(datool_timestamp_ms(coalesce(raw->>'endTime',case when raw->>'type'='EVENT' then raw->>'startTime' end)) is not null) then to_timestamp(max(datool_timestamp_ms(coalesce(raw->>'endTime',case when raw->>'type'='EVENT' then raw->>'startTime' end)))/1000) end as ended
      from langfuse_import_records where run_id=${run.id} and kind='observations' and status='pending' group by raw->>'traceId'
    ) insert into langfuse_import_records(run_id,project_id,kind,source_id,raw,synthetic)
      select ${run.id},${run.project_id},'traces',r.id,
        jsonb_build_object('id',r.id,'timestamp',t.started,'endTime',t.ended,'name',coalesce(r.raw->>'traceName',r.id),'sessionId',r.raw->'sessionId','metadata',jsonb_build_object('reconstructed',true),
          'input',case when nullif(r.raw->>'parentObservationId','') is null then r.raw->'input' end,
          'output',case when nullif(r.raw->>'parentObservationId','') is null then r.raw->'output' end),true
      from roots r join times t on t.id=r.id on conflict(run_id,kind,source_id) do nothing`)
    await tx.execute(sql`insert into langfuse_import_records(run_id,project_id,kind,source_id,raw,synthetic)
      select ${run.id},${run.project_id},'sessions',raw->>'sessionId',jsonb_build_object('id',raw->>'sessionId','createdAt',to_timestamp(min(datool_timestamp_ms(coalesce(raw->>'timestamp',raw->>'startTime')))/1000)),true
      from langfuse_import_records where run_id=${run.id} and kind in ('traces','observations') and status='pending' and nullif(raw->>'sessionId','') is not null
      group by raw->>'sessionId' on conflict(run_id,kind,source_id) do nothing`)
  })
}
async function outcome(
  db: Pick<TracerDatabase, "execute">,
  run: ImportRun,
  row: Staged,
  status: string,
  reason: string | null,
  id: string | null = null
) {
  await db.execute(
    sql`update langfuse_import_records set status=${status},reason=${reason},destination_id=${id} where project_id=${run.project_id} and run_id=${run.id} and kind=${row.kind} and source_id=${row.source_id}`
  )
}
async function saveRecord(db: TracerDatabase, run: ImportRun, row: Staged) {
  try {
    return await db.transaction(async (tx) => {
      const raw = object(row.raw)
      if (row.kind === "scores") {
        const result = await runTracerEffect(
          createImportedScoreService(scopedTracerTransaction(db, tx)).import(
            scoreEnvelope(run, raw)
          )
        )
        await outcome(
          tx,
          run,
          row,
          result.status,
          result.status === "imported"
            ? null
            : result.status === "unresolved"
              ? "SCORE_TARGET_NOT_IMPORTED"
              : "UNSUPPORTED_SCORE",
          result.scoreId
        )
        return result.status === "imported"
      }
      const id = destinationId(run, row.kind, row.source_id)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${id},0))`
      )
      const prior = await tx.execute(
        sql`select raw=${JSON.stringify(row.raw)}::jsonb as same from langfuse_import_entities where project_id=${run.project_id} and id=${id}`
      )
      if (prior.rows[0] && !prior.rows[0].same) {
        await outcome(
          tx,
          run,
          row,
          "conflict",
          "SOURCE_CHANGED_SINCE_PREVIOUS_IMPORT"
        )
        return false
      }
      if (!prior.rows[0]) {
        const table = {
          sessions: "sessions",
          traces: "traces",
          observations: "spans",
        }[row.kind]
        if (
          (
            await tx.execute(
              sql`select id from ${sql.identifier(table)} where id=${id}`
            )
          ).rowCount
        ) {
          await outcome(tx, run, row, "conflict", "DESTINATION_ID_COLLISION")
          return false
        }
      }
      const attrs = attributes(run, row.kind, raw, row.synthetic)
      if (row.kind === "sessions") {
        const created = time(raw.createdAt),
          updated = raw.updatedAt ? time(raw.updatedAt) : created
        await tx.execute(
          sql`insert into sessions(id,project_id,name,attributes_json,created_at,updated_at) values(${id},${run.project_id},${text(raw.name) ?? row.source_id},${JSON.stringify(attrs)},${created},${updated}) on conflict(id) do nothing`
        )
      } else if (row.kind === "traces") {
        const startedAt = time(raw.timestamp)
        // Langfuse traces have no native end timestamp. Use observed end times, never import time or timestamp + latency.
        const bounds = await tx.execute<{ ended: number | null }>(
          sql`select case when bool_and(datool_timestamp_ms(coalesce(raw->>'endTime',case when raw->>'type'='EVENT' then raw->>'startTime' end)) is not null) then max(datool_timestamp_ms(coalesce(raw->>'endTime',case when raw->>'type'='EVENT' then raw->>'startTime' end))) end as ended from langfuse_import_records where run_id=${run.id} and kind='observations' and raw->>'traceId'=${row.source_id}`
        )
        const endedAt = raw.endTime
          ? time(raw.endTime)
          : bounds.rows[0]?.ended != null
            ? new Date(Number(bounds.rows[0].ended)).toISOString()
            : undefined
        const sessionId = text(raw.sessionId)
          ? destinationId(run, "sessions", String(raw.sessionId))
          : null
        if (
          sessionId &&
          !(
            await tx.execute(
              sql`select id from sessions where project_id=${run.project_id} and id=${sessionId} for key share`
            )
          ).rowCount
        ) {
          await outcome(tx, run, row, "unresolved", "SESSION_NOT_IMPORTED")
          return false
        }
        const input = parseCreateTrace({
          id,
          name: text(raw.name) ?? row.source_id,
          operation: "langfuse",
          startedAt,
          ...(endedAt ? { endedAt } : {}),
          status: endedAt ? "completed" : "running",
          attributes: attrs,
          input: io(
            raw.input,
            row.synthetic && run.checkpoint.modes.observations === "modern"
          ),
          output: io(
            raw.output,
            row.synthetic && run.checkpoint.modes.observations === "modern"
          ),
        })
        await tx.execute(
          sql`insert into traces(id,project_id,session_id,name,operation,input_json,output_json,attributes_json,status,started_at,ended_at) values(${id},${run.project_id},${sessionId},${input.name!},'langfuse',${JSON.stringify(input.input ?? null)},${JSON.stringify(input.output ?? null)},${JSON.stringify(attrs)}::jsonb,${input.status!},${startedAt},${endedAt ?? null}) on conflict(id) do nothing`
        )
      } else {
        const traceId = text(raw.traceId)
          ? destinationId(run, "traces", String(raw.traceId))
          : null
        const parentId = text(raw.parentObservationId)
          ? destinationId(run, "observations", String(raw.parentObservationId))
          : null
        if (
          !traceId ||
          !(
            await tx.execute(
              sql`select id from traces where project_id=${run.project_id} and id=${traceId} for key share`
            )
          ).rowCount
        ) {
          await outcome(tx, run, row, "unresolved", "TRACE_NOT_IMPORTED")
          return false
        }
        if (
          parentId &&
          !(
            await tx.execute(
              sql`select id from spans where project_id=${run.project_id} and trace_id=${traceId} and id=${parentId} for key share`
            )
          ).rowCount
        ) {
          await outcome(
            tx,
            run,
            row,
            "unresolved",
            "PARENT_NOT_IMPORTED_OR_CYCLIC"
          )
          return false
        }
        const startedAt = time(raw.startTime),
          endedAt = raw.endTime
            ? time(raw.endTime)
            : raw.type === "EVENT"
              ? startedAt
              : undefined
        const input = parseCreateSpan({
          id,
          name: text(raw.name) ?? row.source_id,
          kind: observationKind(raw.type),
          startedAt,
          ...(endedAt ? { endedAt } : {}),
          status:
            raw.level === "ERROR"
              ? "errored"
              : endedAt
                ? "completed"
                : "running",
          parentId,
          attributes: attrs,
          input: io(raw.input, run.checkpoint.modes.observations === "modern"),
          output: io(
            raw.output,
            run.checkpoint.modes.observations === "modern"
          ),
        })
        await tx.execute(
          sql`insert into spans(id,project_id,trace_id,parent_id,name,kind,input_json,output_json,attributes_json,status,started_at,ended_at) values(${id},${run.project_id},${traceId},${parentId},${input.name},${input.kind!},${JSON.stringify(input.input ?? null)},${JSON.stringify(input.output ?? null)},${JSON.stringify(attrs)}::jsonb,${input.status!},${startedAt},${endedAt ?? null}) on conflict(id) do nothing`
        )
      }
      await tx.execute(
        sql`insert into langfuse_import_entities(id,project_id,kind,raw) values(${id},${run.project_id},${row.kind},${JSON.stringify(row.raw)}::jsonb) on conflict(id) do nothing`
      )
      await outcome(tx, run, row, "imported", null, id)
      return true
    })
  } catch (error) {
    if (
      error instanceof SourceError ||
      (error instanceof TracerError && [400, 409].includes(error.status))
    ) {
      await outcome(
        db,
        run,
        row,
        error instanceof TracerError && error.status === 409
          ? "conflict"
          : "unsupported",
        error instanceof SourceError
          ? error.code
          : error.status === 409
            ? "SOURCE_SCORE_CONFLICT"
            : "INVALID_SOURCE_RECORD"
      )
      return false
    }
    throw error
  }
}
export async function materialize(
  db: TracerDatabase,
  run: ImportRun,
  signal?: AbortSignal
) {
  if (getTracerProjectId(db) !== run.project_id)
    throw new SourceError("IMPORT_PROJECT_MISMATCH")
  for (const kind of kinds) {
    // A restart or explicit resume can resolve objects whose parents were imported later.
    await db.execute(
      sql`update langfuse_import_records set status='pending',reason=null where run_id=${run.id} and kind=${kind} and status='unresolved'`
    )
    let progress: boolean
    do {
      progress = false
      for (;;) {
        if (signal?.aborted) throw new SourceError("IMPORT_INTERRUPTED", true)
        const result = await db.execute<Staged>(
          sql`select source_id,kind,raw,synthetic,status from langfuse_import_records where project_id=${run.project_id} and run_id=${run.id} and kind=${kind} and status='pending' order by source_id limit 100`
        )
        if (!result.rows.length) break
        for (const row of result.rows) {
          if (signal?.aborted) throw new SourceError("IMPORT_INTERRUPTED", true)
          progress = (await saveRecord(db, run, row)) || progress
        }
      }
      if (kind === "observations" && progress)
        await db.execute(
          sql`update langfuse_import_records set status='pending' where run_id=${run.id} and kind=${kind} and status='unresolved'`
        )
    } while (kind === "observations" && progress)
  }
}

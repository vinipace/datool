import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { getTracerProjectId, type TracerDatabase } from "../../tracer/db"
import {
  type Kind,
  type Mode,
  normalizeHost,
  type Page,
  SourceError,
} from "./client"

export const kinds: Kind[] = ["sessions", "traces", "observations", "scores"]
export type Checkpoint = {
  phase: Kind | "derive" | "materialize" | "done"
  token: string | null
  modes: Partial<Record<Kind, Mode | "unavailable">>
  warnings: string[]
}
export type ImportRun = {
  id: string
  project_id: string
  host: string
  source_project_id: string
  from_time: string
  to_time: string
  page_size: number
  status: string
  checkpoint: Checkpoint
  error_code: string | null
}
export type Staged = {
  source_id: string
  kind: Kind
  raw: unknown
  synthetic: boolean
  status: string
}
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const destinationId = (run: ImportRun, kind: Kind, sourceId: string) =>
  `lf_${digest([run.project_id, run.host, run.source_project_id, kind, sourceId])}`
const startSchema = z.object({
  host: z.string(),
  sourceProjectId: z.string().min(1),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  pageSize: z.number().int().min(1).max(100).default(50),
})
export async function createRun(
  db: TracerDatabase,
  input: z.input<typeof startSchema>
) {
  const value = startSchema.parse(input)
  if (Date.parse(value.from) >= Date.parse(value.to))
    throw new SourceError("INVALID_IMPORT_WINDOW")
  const id = randomUUID(),
    projectId = getTracerProjectId(db)
  await db.execute(
    sql`insert into langfuse_import_runs(id,project_id,host,source_project_id,from_time,to_time,page_size) values(${id},${projectId},${normalizeHost(value.host)},${value.sourceProjectId},${new Date(value.from).toISOString()},${new Date(value.to).toISOString()},${value.pageSize})`
  )
  return readRun(db, id)
}
export async function readRun(
  db: TracerDatabase,
  id: string
): Promise<ImportRun> {
  const result = await db.execute<ImportRun>(
    sql`select * from langfuse_import_runs where project_id=${getTracerProjectId(db)} and id=${id}`
  )
  if (!result.rows[0]) throw new SourceError("IMPORT_NOT_FOUND")
  return result.rows[0]
}
export async function checkpoint(
  db: TracerDatabase,
  run: ImportRun,
  next: Checkpoint
) {
  await db.execute(
    sql`update langfuse_import_runs set checkpoint=${JSON.stringify(next)}::jsonb,updated_at=now() where project_id=${run.project_id} and id=${run.id}`
  )
  run.checkpoint = next
}
export async function stagePage(
  db: TracerDatabase,
  run: ImportRun,
  kind: Kind,
  page: Page,
  next: Checkpoint
) {
  await db.transaction(async (tx) => {
    const pageToken = JSON.stringify(run.checkpoint.token)
    if (
      (
        await tx.execute(
          sql`select 1 from langfuse_import_pages where run_id=${run.id} and kind=${kind} and token=${pageToken}`
        )
      ).rowCount
    )
      throw new SourceError("LANGFUSE_PAGINATION_LOOP")
    await tx.execute(
      sql`insert into langfuse_import_pages(run_id,kind,token,row_count,source_total) values(${run.id},${kind},${pageToken},${page.rows.length},${page.total})`
    )
    for (const raw of page.rows) {
      const object =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      if (
        object.projectId !== undefined &&
        object.projectId !== run.source_project_id
      )
        throw new SourceError("LANGFUSE_RECORD_PROJECT_MISMATCH")
      const validId = typeof object.id === "string" && object.id.length > 0
      const sourceId = validId
        ? (object.id as string)
        : `invalid_${digest(raw)}`
      await tx.execute(sql`insert into langfuse_import_records(run_id,project_id,kind,source_id,raw,status,reason) values(${run.id},${run.project_id},${kind},${sourceId},${JSON.stringify(raw)}::jsonb,${validId ? "pending" : "unsupported"},${validId ? null : "MISSING_SOURCE_ID"})
        on conflict(run_id,kind,source_id) do update set
          raw=case when langfuse_import_records.raw=excluded.raw then langfuse_import_records.raw else jsonb_build_object('first',langfuse_import_records.raw,'conflicting',excluded.raw) end,
          status=case when langfuse_import_records.raw=excluded.raw then langfuse_import_records.status else 'conflict' end,
          reason=case when langfuse_import_records.raw=excluded.raw then langfuse_import_records.reason else 'SOURCE_CHANGED_DURING_EXPORT' end`)
    }
    await tx.execute(
      sql`update langfuse_import_runs set checkpoint=${JSON.stringify(next)}::jsonb,updated_at=now() where project_id=${run.project_id} and id=${run.id}`
    )
  })
  run.checkpoint = next
}
export async function report(db: TracerDatabase, id: string) {
  const run = await readRun(db, id)
  const records = await db.execute(
    sql`select kind,status,synthetic,count(*)::int as count from langfuse_import_records where project_id=${run.project_id} and run_id=${id} group by kind,status,synthetic order by kind,status,synthetic`
  )
  const pages = await db.execute(
    sql`select kind,count(*)::int as pages,sum(row_count)::int as fetched,min(source_total)::int as "minTotal",max(source_total)::int as "maxTotal" from langfuse_import_pages where run_id=${id} group by kind order by kind`
  )
  const issues = await db.execute(
    sql`select kind,source_id as "sourceId",status,reason from langfuse_import_records where project_id=${run.project_id} and run_id=${id} and status not in ('imported','pending') order by kind,source_id limit 50`
  )
  return {
    id,
    projectId: run.project_id,
    sourceProjectId: run.source_project_id,
    host: run.host,
    from: run.from_time,
    to: run.to_time,
    status: run.status,
    checkpoint: run.checkpoint,
    errorCode: run.error_code,
    counts: records.rows,
    pages: pages.rows,
    issues: issues.rows,
  }
}

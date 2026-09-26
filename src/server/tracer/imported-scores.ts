import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import {
  importedScoreSchema,
  scoreImportSchema,
  type ImportedScore,
  type ScoreImportResult,
  type ScoreImportDetail,
} from "@/src/lib/tracer/imported-scores"
import { collectionSqlPage } from "./collection-sql"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"

export function createImportedScoreService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const statusColumns = sql`case when i.status='imported' and s.id is null then 'unresolved' else i.status end as status,
    case when i.status='imported' and s.id is null then 'The imported score was deleted. The original record is retained and can be retried.' else i.reason end as reason`
  return {
    list: (options: { cursor?: string | null; limit?: number } = {}) =>
      tracerEffect(() =>
        collectionSqlPage<ScoreImportResult & { createdAt: string }>(
          database,
          sql`select i.id, ${statusColumns}, s.id as "scoreId", i.created_at as "createdAt" from score_imports i left join scores s on s.project_id=i.project_id and s.import_id=i.id where i.project_id=${projectId}`,
          options,
          "createdAt"
        )
      ),
    get: (id: string) =>
      tracerEffect(async () => {
        const result = await database.execute<ScoreImportDetail>(
          sql`select i.id, i.payload, ${statusColumns}, s.id as "scoreId", s.external_json as score from score_imports i left join scores s on s.project_id=i.project_id and s.import_id=i.id where i.project_id=${projectId} and i.id=${id}`
        )
        if (!result.rows[0]) throw notFound("Score import", id)
        return result.rows[0]
      }),
    import: (input: unknown) =>
      tracerEffect(async (): Promise<ScoreImportResult> => {
        const envelope = scoreImportSchema.safeParse(input)
        if (!envelope.success)
          throw validation(
            "A score import requires a source identity and a JSON record."
          )
        const { source, record } = envelope.data
        const id = `import_${createHash("sha256")
          .update(
            JSON.stringify([
              projectId,
              source.provider,
              source.instance,
              source.projectId,
              source.id,
            ])
          )
          .digest("hex")}`
        const payload = JSON.stringify(envelope.data)
        const parsed = importedScoreSchema.safeParse(record)
        return database.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`
          )
          const existing = await tx.execute(
            sql`select payload = ${payload}::jsonb as same from score_imports where project_id=${projectId} and id=${id}`
          )
          if (existing.rows[0] && !existing.rows[0].same)
            throw new TracerError(
              "CONFLICT",
              "This source score already has a different payload. The original record was retained."
            )
          let status: ScoreImportResult["status"] = "unsupported"
          let reason: string | null = parsed.success
            ? null
            : parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")
          let traceId: string | null = null,
            spanId: string | null = null,
            sessionId: string | null = null,
            evalRunId: string | null = null
          if (parsed.success) {
            const target = parsed.data.target
            const table = {
              trace: "traces",
              span: "spans",
              session: "sessions",
              evalRun: "eval_runs",
            }[target.type]
            const found = await tx.execute(
              sql`select id ${target.type === "span" ? sql`, trace_id as "traceId"` : sql``} from ${sql.identifier(table)} where project_id=${projectId} and id=${target.id} for key share`
            )
            if (!found.rows[0]) {
              status = "unresolved"
              reason =
                "The target is not available in this project. Import it first, then retry this record."
            } else {
              status = "imported"
              if (target.type === "trace") traceId = target.id
              if (target.type === "span") {
                spanId = target.id
                traceId = String(found.rows[0].traceId)
              }
              if (target.type === "session") sessionId = target.id
              if (target.type === "evalRun") evalRunId = target.id
            }
          }
          const now = new Date().toISOString()
          await tx.execute(
            sql`insert into score_imports(id,project_id,payload,status,reason,created_at,updated_at) values(${id},${projectId},${payload}::jsonb,${status},${reason},${now},${now}) on conflict(id) do update set status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`
          )
          const scoreId = status === "imported" ? `score_${id.slice(7)}` : null
          if (scoreId && parsed.success) {
            const score: ImportedScore = { ...parsed.data, source }
            const value =
              score.data.type === "numeric" ? score.data.value : null
            await tx.execute(
              sql`insert into scores(id,project_id,trace_id,span_id,session_id,eval_run_id,import_id,name,value,status,created_at,external_json) values(${scoreId},${projectId},${traceId},${spanId},${sessionId},${evalRunId},${id},${score.name},${value},'ok',${score.timestamp},${JSON.stringify(score)}::jsonb) on conflict(id) do nothing`
            )
          }
          return { id, status, reason, scoreId }
        })
      }),
  }
}

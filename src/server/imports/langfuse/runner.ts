import { sql } from "drizzle-orm"
import {
  getTracerSnapshotClientFactory,
  type TracerDatabase,
} from "../../tracer/db"
import { LangfuseClient, SourceError, type Kind, type Mode } from "./client"
import { checkpoint, kinds, readRun, report, stagePage } from "./store"
import { deriveContainers, materialize } from "./materialize"

export async function runImport(
  db: TracerDatabase,
  id: string,
  client: LangfuseClient,
  options: { signal?: AbortSignal; afterPage?: () => Promise<void> } = {}
) {
  let run = await readRun(db, id)
  const connect = getTracerSnapshotClientFactory(db)
  if (!connect) throw new SourceError("IMPORT_DATABASE_CONNECTION_REQUIRED")
  const lock = await connect()
  let locked = false
  try {
    const acquired = await lock.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as acquired",
      [`langfuse:${run.project_id}:${id}`]
    )
    if (!acquired.rows[0].acquired)
      throw new SourceError("IMPORT_ALREADY_RUNNING", true)
    locked = true
    run = await readRun(db, id)
    if (
      run.host !== client.host ||
      run.source_project_id !== (await client.project())
    )
      throw new SourceError("LANGFUSE_SOURCE_IDENTITY_MISMATCH")
    if (run.checkpoint.phase === "done" && run.status === "completed")
      return report(db, id)
    await db.execute(
      sql`update langfuse_import_runs set status='running',error_code=null,updated_at=now() where project_id=${run.project_id} and id=${id}`
    )
    while (kinds.includes(run.checkpoint.phase as Kind)) {
      if (options.signal?.aborted)
        throw new SourceError("IMPORT_INTERRUPTED", true)
      const kind = run.checkpoint.phase as Kind
      const mode = (run.checkpoint.modes[kind] ??
        (["observations", "scores"].includes(kind)
          ? "modern"
          : "legacy")) as Mode
      try {
        const page = await client.page(
          kind,
          mode,
          run.from_time,
          run.to_time,
          run.checkpoint.token,
          run.page_size
        )
        await stagePage(db, run, kind, page, {
          ...run.checkpoint,
          modes: { ...run.checkpoint.modes, [kind]: mode },
          token: page.next,
          phase: page.next
            ? kind
            : (kinds[kinds.indexOf(kind) + 1] ?? "derive"),
        })
        await options.afterPage?.()
      } catch (error) {
        if (
          error instanceof SourceError &&
          ["LANGFUSE_HTTP_404", "LANGFUSE_HTTP_410"].includes(error.code) &&
          run.checkpoint.token === null
        ) {
          if (mode === "modern") {
            await checkpoint(db, run, {
              ...run.checkpoint,
              modes: { ...run.checkpoint.modes, [kind]: "legacy" },
            })
            continue
          }
          if (kind === "sessions" || kind === "traces") {
            await checkpoint(db, run, {
              ...run.checkpoint,
              modes: { ...run.checkpoint.modes, [kind]: "unavailable" },
              warnings: [
                ...run.checkpoint.warnings,
                `ORIGINAL_${kind.toUpperCase()}_API_UNAVAILABLE`,
              ],
              phase: kinds[kinds.indexOf(kind) + 1],
            })
            continue
          }
        }
        throw error
      }
    }
    if (run.checkpoint.phase === "derive") {
      await deriveContainers(db, run)
      await checkpoint(db, run, {
        ...run.checkpoint,
        phase: "materialize",
        token: null,
      })
    }
    await materialize(db, run, options.signal)
    const summary = await report(db, id)
    const warnings = new Set(run.checkpoint.warnings)
    for (const page of summary.pages) {
      const actual = summary.counts
        .filter((row) => row.kind === page.kind && !row.synthetic)
        .reduce((sum, row) => sum + Number(row.count), 0)
      if (
        page.minTotal !== null &&
        (Number(page.minTotal) !== Number(page.maxTotal) ||
          Number(page.maxTotal) !== actual)
      )
        warnings.add(`SOURCE_COUNT_MISMATCH_${String(page.kind).toUpperCase()}`)
    }
    const issues =
      summary.counts.some((row) => row.status !== "imported") ||
      warnings.size > 0
    await checkpoint(db, run, {
      ...run.checkpoint,
      phase: "done",
      warnings: [...warnings],
    })
    await db.execute(
      sql`update langfuse_import_runs set status=${issues ? "completed_with_issues" : "completed"},error_code=null,updated_at=now() where project_id=${run.project_id} and id=${id}`
    )
    return report(db, id)
  } catch (error) {
    if (locked)
      await db.execute(
        sql`update langfuse_import_runs set status='failed',error_code=${error instanceof SourceError ? error.code : "IMPORT_PERSISTENCE_OR_WORKER_ERROR"},updated_at=now() where project_id=${run.project_id} and id=${id}`
      )
    throw error instanceof SourceError
      ? error
      : new SourceError("IMPORT_PERSISTENCE_OR_WORKER_ERROR", true)
  } finally {
    try {
      if (locked)
        await lock.query("select pg_advisory_unlock(hashtextextended($1,0))", [
          `langfuse:${run.project_id}:${id}`,
        ])
    } finally {
      lock.release()
    }
  }
}

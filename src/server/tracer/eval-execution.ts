import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  DatasetItemForEvaluation,
  Evaluator,
  EvaluatorRunResult,
  TraceDetail,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"
import { scopedTracerTransaction, type TracerDatabase } from "./db"
import { collectEvalAttributions, saveEvalAttributions } from "./eval-attribution"
import type { EvalAttribution } from "@/src/lib/tracer/eval-attribution"
import { getTracerProjectId } from "./db"
import type { TracerService } from "./service"
import { runTracerEffect as run } from "./effect"
import { notFound, TracerError } from "./errors"
import {
  executeInvocation,
  invocationEvidence,
  type ResolvedApp,
} from "../apps/invoke"
import { executeScorerWithSpan, scorerEvidence } from "./scorer-execution"
import { RuntimeCircuit } from "./runtime-diagnostics"
import { canonicalJson } from "@/src/lib/tracer/resource-document"

export type ExecutionTarget = {
  attributions?: EvalAttribution[]
  targetId?: string
  datasetItemReference?: string | null
  datasetItem: DatasetItemForEvaluation | null
  trace: TraceForEvaluation
}

/** A token fences every checkpoint. Losing a lease never authorizes an old worker to dispatch more work. */
export function evalExecution(
  database: TracerDatabase,
  service: TracerService,
  options: {
    resolveApp: (id: string) => Promise<ResolvedApp>
    persist: (
      id: string,
      target: ExecutionTarget,
      evaluator: Evaluator,
      result: EvaluatorRunResult,
      owner: string
    ) => Promise<void>
  }
) {
  const project = getTracerProjectId(database)
  async function claim(id: string, recovery = false) {
    return database.transaction(async (tx) => {
      const record = (
        await tx.execute(
          sql`select status from eval_runs where project_id=${project} and id=${id} for update`
        )
      ).rows[0]
      if (!record) throw notFound("Eval run", id)
      if (record.status === "cancelled")
        throw new TracerError(
          "CONFLICT",
          "Cancelled runs cannot be recovered. Create a new run explicitly."
        )
      if (recovery && record.status === "completed") return null
      const owner = randomUUID()
      const lease =
        await tx.execute(sql`insert into eval_run_lease(run_id,owner,expires_at) values (${id},${owner},now()+interval '45 seconds')
        on conflict(run_id) do update set owner=excluded.owner,expires_at=excluded.expires_at where eval_run_lease.expires_at<=now() returning owner`)
      if (!lease.rows.length)
        throw new TracerError(
          "CONFLICT",
          "This run still has a live worker. Cancel it or wait for its lease to expire."
        )
      await tx.execute(
        sql`update eval_runs set status='running',completed_at=null,metadata_json=(metadata_json::jsonb-'executionError'-'interruption')::text where project_id=${project} and id=${id}`
      )
      return owner
    })
  }
  async function active(id: string, owner: string) {
    const row = (
      await database.execute(sql`select 1 from eval_runs r join eval_run_lease l on l.run_id=r.id
      where r.project_id=${project} and r.id=${id} and r.status='running' and l.owner=${owner} and l.expires_at>now()`)
    ).rows[0]
    if (!row)
      throw new TracerError(
        "CONFLICT",
        "Run cancelled or execution lease lost."
      )
  }
  async function execute(id: string, owner: string) {
    const renew = setInterval(() => {
      void database
        .execute(
          sql`update eval_run_lease set expires_at=now()+interval '45 seconds' where run_id=${id} and owner=${owner} and expires_at>now()`
        )
        .catch(() => {})
    }, 10000)
    try {
      const record = (
        await database.execute(
          sql`select metadata_json::jsonb as metadata from eval_runs where project_id=${project} and id=${id}`
        )
      ).rows[0]
      const metadata = record.metadata as Record<string, unknown>
      const pinnedApp =
        metadata.mode === "connected"
          ? (metadata.app as ResolvedApp["definition"])
          : undefined
      const targetRows = (
        await database.execute(
          sql`select id,stage from eval_run_targets where project_id=${project} and run_id=${id} order by ordinal`
        )
      ).rows
      const versions = (
        await database.execute(
          sql`select evaluator_id,evaluator_version_id from eval_run_evaluators where project_id=${project} and run_id=${id}`
        )
      ).rows
      const evaluators = await Promise.all(
        versions.map(async (row) => ({
          ...(await run(service.getEvaluator(String(row.evaluator_id)))),
          activeVersion: await service.agent.scorerVersion(
            String(row.evaluator_id),
            String(row.evaluator_version_id)
          ),
        }))
      )
      const circuit = new RuntimeCircuit()
      let index = 0
      const checkpoint = async (
        target: ExecutionTarget,
        stage: string,
        error: string | null = null,
        attributionWrite: "insert" | "replace" | null = null
      ) => {
        await active(id, owner)
        const persist = async (db: TracerDatabase) => {
          const changed = await db.execute(sql`update eval_run_targets set stage=${stage},progress_at=now(),execution_error=${error},snapshot_json=${JSON.stringify(target)}
          where project_id=${project} and run_id=${id} and id=${target.targetId} and exists(select 1 from eval_run_lease l join eval_runs r on r.id=l.run_id where r.id=${id} and r.status='running' and l.owner=${owner} and l.expires_at>now()) returning id`)
          if (!changed.rows.length)
            throw new TracerError("CONFLICT", "Execution ownership changed.")
          if (attributionWrite && target.attributions)
            await saveEvalAttributions(db, id, [{ targetId: target.targetId!, attributions: target.attributions }], attributionWrite === "replace")
        }
        if (attributionWrite) await database.transaction(tx => persist(scopedTracerTransaction(database, tx)))
        else await persist(database)
      }

      const work = async () => {
        while (index < targetRows.length) {
          const row = targetRows[index++]
          await active(id, owner)
          const savedTarget = (
            await database.execute(
              sql`select snapshot_json from eval_run_targets where project_id=${project} and run_id=${id} and id=${row.id}`
            )
          ).rows[0]
          const target = JSON.parse(
            String(savedTarget.snapshot_json)
          ) as ExecutionTarget
          target.targetId = String(row.id)
          let dispatched = row.stage !== "queued"
          const evidenceCaptured =
            ["scoring", "completed", "error"].includes(String(row.stage)) &&
            target.trace.status === "completed"
          try {
            if (
              pinnedApp &&
              (["legacy", "queued", "invoking", "blocked"].includes(
                String(row.stage)
              ) ||
                (row.stage === "error" && target.trace.status !== "completed"))
            ) {
              const current = await run(
                service.getTraceArtifact(target.trace.id)
              )
              if (current.status === "completed") target.trace = current
              else if (row.stage === "queued") {
                const app = await options.resolveApp(pinnedApp.id)
                if (
                  canonicalJson(app.definition) !== canonicalJson(pinnedApp)
                ) {
                  await checkpoint(
                    target,
                    "queued",
                    "App definition or source fingerprint changed. Restore the recorded app before recovery."
                  )
                  continue
                }
                await checkpoint(target, "invoking")
                await active(id, owner)
                dispatched = true
                target.trace = await executeInvocation(service, app, current, {
                  projectId: project,
                  runId: id,
                })
              } else {
                // A bridge may have durably acknowledged output before its waiting server crashed.
                const job = (
                  await database.execute(
                    sql`select result from app_bridge_job where project_id=${project} and call_id=${String(current.attributes["datool.call.id"] ?? "")}`
                  )
                ).rows[0]
                const result = job?.result as
                  | {
                      ok?: boolean
                      output?: unknown
                      telemetryComplete?: boolean
                    }
                  | undefined
                if (result?.ok === true) {
                  target.trace = await run(
                    service.patchTrace(current.id, {
                      status: "completed",
                      output: result.output as TraceDetail["output"],
                      endedAt: new Date().toISOString(),
                      attributes: {
                        ...current.attributes,
                        "datool.telemetry.flushed":
                          result.telemetryComplete === true,
                      },
                    })
                  )
                } else {
                  await checkpoint(
                    target,
                    "blocked",
                    "Application completion is uncertain; the existing call was not dispatched again. Inspect its trace/bridge result or create an explicit new run."
                  )
                  continue
                }
              }
            }
            if (
              target.trace.status === "errored" ||
              target.trace.status === "running"
            ) {
              await checkpoint(
                target,
                "error",
                String(
                  target.trace.attributes["error.message"] ??
                    "Application did not complete"
                )
              )
            } else if (!evidenceCaptured) {
              await checkpoint(
                target,
                pinnedApp?.internalTracing ? "awaiting_delivery" : "capturing"
              )
              if (!metadata.sourceRunId && !target.trace.selectedSpanId)
                target.trace = await invocationEvidence(
                  service,
                  target.trace as TraceDetail,
                  pinnedApp?.internalTracing ?? false
                )
            }
            if (
              pinnedApp?.internalTracing &&
              target.trace.attributes["datool.trace.coverage"] === "incomplete"
            ) {
              await checkpoint(
                target,
                "awaiting_delivery",
                "Application output is saved, but trace delivery is incomplete. Recovery will recheck delivery without invoking the app again."
              )
              continue
            }
            const hadAttribution = target.attributions !== undefined
            const previousAttribution = canonicalJson(target.attributions ?? null)
            if (!metadata.sourceRunId && !evidenceCaptured)
              target.attributions = collectEvalAttributions(target.trace)
            target.trace = scorerEvidence(target.trace)
            await checkpoint(target, "scoring", null, previousAttribution === canonicalJson(target.attributions ?? null) ? null : hadAttribution ? "replace" : "insert")
            const scorerItem = target.datasetItem ? await service.agent.hydrateDatasetItem(target.datasetItem) : null
            for (const evaluator of evaluators) {
              await active(id, owner)
              const existing = (
                await database.execute(
                  sql`select status from eval_results where project_id=${project} and run_id=${id} and evaluator_id=${evaluator.id} and (target_id=${target.targetId} or (target_id is null and metadata_json::jsonb->>'evalTargetId'=${target.targetId})) and status<>'error' limit 1`
                )
              ).rows[0]
              if (existing) continue
              const saved = (
                await database.execute(
                  sql`select output_json::text as output_json,attributes_json::text as attributes_json from spans where project_id=${project} and trace_id=${target.trace.id} and status='completed' and attributes_json::jsonb->>'eval.run_id'=${id} and attributes_json::jsonb->>'eval.target_id'=${target.targetId} and attributes_json::jsonb->>'scorer.version_id'=${evaluator.activeVersion.id} order by ended_at desc limit 1`
                )
              ).rows[0]
              const config = evaluator.activeVersion.config
              const runtimeKey =
                config?.type === "library"
                  ? `library:${config.library?.evaluator}:${config.provider}:${config.model}`
                  : config?.type === "llm"
                  ? `llm:${config.provider}:${config.model}`
                  : `sandbox:${config?.type ?? evaluator.activeVersion.language}`
              const result: EvaluatorRunResult = saved
                ? {
                    ...JSON.parse(String(saved.output_json)),
                    metadata: JSON.parse(String(saved.attributes_json)),
                  }
                : await circuit.run(runtimeKey, () =>
                    executeScorerWithSpan(service, {
                      database,
                      version: evaluator.activeVersion,
                      name: evaluator.name,
                      trace: target.trace,
                      datasetItem: scorerItem,
                      projectId: project,
                      runId: id,
                      targetId: target.targetId,
                      ...(target.trace.status !== "completed"
                        ? {
                            skippedError: String(
                              target.trace.attributes["error.message"] ??
                                "App execution failed"
                            ),
                          }
                        : {}),
                    })
                  )
              await options.persist(id, target, evaluator, result, owner)
            }
            const failures = (
              await database.execute(
                sql`select 1 from eval_results where project_id=${project} and run_id=${id} and (target_id=${target.targetId} or (target_id is null and metadata_json::jsonb->>'evalTargetId'=${target.targetId})) and status='error' limit 1`
              )
            ).rows.length
            await checkpoint(
              target,
              target.trace.status !== "completed" || failures
                ? "error"
                : "completed"
            )
          } catch (error) {
            await checkpoint(
              target,
              dispatched ? "error" : "queued",
              error instanceof Error ? error.message : "Execution failed"
            )
          }
        }
      }
      const workers = await Promise.allSettled(
        Array.from(
          {
            length: pinnedApp
              ? Math.min(16, Math.max(1, Number(metadata.concurrency) || 4))
              : 1,
          },
          work
        )
      )
      const failure = workers.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
      await active(id, owner)
      await database.execute(sql`update eval_runs set
        groups_resolved_at=case when groups_resolved_at is not null then groups_resolved_at
          when not exists(select 1 from eval_run_targets t where t.project_id=${project} and t.run_id=${id}
            and not exists(select 1 from eval_target_attributions a where a.project_id=${project} and a.run_id=${id} and a.target_id=t.id)) then ${new Date().toISOString()} else null end,
        completed_at=${new Date().toISOString()},status=(
        select case when bool_and(stage='completed') then 'completed' when bool_or(stage='completed') then 'partial' else 'failed' end from eval_run_targets where project_id=${project} and run_id=${id})
        where project_id=${project} and id=${id} and status='running' and exists(select 1 from eval_run_lease where run_id=${id} and owner=${owner} and expires_at>now())`)
    } catch (error) {
      await database
        .execute(
          sql`update eval_runs set status='failed',completed_at=${new Date().toISOString()},metadata_json=(metadata_json::jsonb || ${JSON.stringify({ executionError: error instanceof Error ? error.message : "Execution failed" })}::jsonb)::text
        where project_id=${project} and id=${id} and status='running' and exists(select 1 from eval_run_lease where run_id=${id} and owner=${owner})`
        )
        .catch(() => {})
      throw error
    } finally {
      clearInterval(renew)
      await database
        .execute(
          sql`delete from eval_run_lease where run_id=${id} and owner=${owner}`
        )
        .catch(() => {})
    }
  }
  async function cancel(id: string) {
    await database.transaction(async (tx) => {
      const row = (
        await tx.execute(
          sql`select status from eval_runs where project_id=${project} and id=${id} for update`
        )
      ).rows[0]
      if (!row) throw notFound("Eval run", id)
      if (row.status === "completed" || row.status === "cancelled") return
      await tx.execute(
        sql`update eval_runs set status='cancelled',completed_at=${new Date().toISOString()} where project_id=${project} and id=${id}`
      )
      await tx.execute(sql`update app_bridge_job set result='{"ok":false,"error":"Evaluation cancelled before dispatch"}'::jsonb
        where project_id=${project} and claim_id is null and result is null and job#>>'{promptScope,runId}'=${id}`)
      await tx.execute(sql`delete from eval_run_lease where run_id=${id}`)
    })
    return run(service.getEvalRun(id, { includeEvidence: false }))
  }
  return {
    claim,
    execute,
    cancel,
    recover: async (id: string) => {
      const owner = await claim(id, true)
      if (owner)
        setImmediate(() => {
          void execute(id, owner).catch(() => {})
        })
      return run(service.getEvalRun(id, { includeEvidence: false }))
    },
  }
}

export async function executionState(
  database: TracerDatabase,
  project: string,
  id: string
) {
  const row = (
    await database.execute(sql`select
    exists(select 1 from eval_run_lease where run_id=${id} and expires_at>now()) as "workerOnline",
    (select max(progress_at) from eval_run_targets where project_id=${project} and run_id=${id}) as "lastProgressAt",
    coalesce((select jsonb_object_agg(stage,n) from (select stage,count(*)::int n from eval_run_targets where project_id=${project} and run_id=${id} group by stage) c),'{}'::jsonb) as stages`)
  ).rows[0]
  return {
    workerOnline: Boolean(row.workerOnline),
    lastProgressAt: row.lastProgressAt
      ? new Date(String(row.lastProgressAt)).toISOString()
      : null,
    stages: row.stages as Record<string, number>,
    stalled:
      !row.workerOnline ||
      Date.now() - new Date(String(row.lastProgressAt)).getTime() > 300_000,
  }
}

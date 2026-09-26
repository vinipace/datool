import {
  datasetCase,
  datasetHeader,
  datasetHash,
  writeSnapshot,
  snapshotManifest,
  snapshotPage,
  hydrateDatasetItem,
} from "./dataset-snapshots"
import { scorerReadiness } from "./scorer-readiness"
import { RuntimeCircuit } from "./runtime-diagnostics"
import { captureSpanEvidence } from "./span-evidence"
import { promoteSpansSchema, type PromoteSpansInput, type SpanPromotionResult } from "@/src/lib/tracer/span-promotion"
import type { TracerEffect } from "./effect"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  CreateDatasetItemInput,
  CreateEvalRunInput,
  DatasetDetail,
  DatasetItemForEvaluation,
  EvaluatorVersion,
  PatchDatasetItemInput,
} from "@/src/lib/tracer/contracts"
import type { ScorerInput } from "@/src/lib/tracer/scorers"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import type { TracerService } from "./service"
import {
  getTracerProjectId,
  scopedTracerTransaction,
  type TracerDatabase,
} from "./db"
import { runTracerEffect, tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { collectionSqlPage } from "./collection-sql"
import { assertRelationBytes } from "./read-size"
import { boundedReadTransaction } from "./read-transaction"
import { withReadBudget, READ_MAX_BYTES } from "../semantic/read-budget"
import { executeScorerWithSpan, scorerEvidence } from "./scorer-execution"
import { invocationEvidence } from "../apps/invoke"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import type { SemanticResult } from "@/src/lib/semantic/result"

type Page = { limit?: number; cursor?: string; includeTotal?: boolean }
type Snapshot = {
  id: string
  datasetId: string
  contentHash: string
  label: string | null
  itemCount: number
  createdAt: string
}
export type BulkDatasetInput = {
  datasetId: string
  expectedHash?: string
  create?: CreateDatasetItemInput[]
  update?: { id: string; patch: PatchDatasetItemInput }[]
  delete?: string[]
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")

/** Every query is scoped to the service's trusted project, never a caller field. */
export function createAgentFoundations(
  database: TracerDatabase,
  serviceFor: (db: TracerDatabase) => TracerService
) {
  const project = getTracerProjectId(database)
  const service = () => serviceFor(database)
  const read = <T>(work: (db: TracerDatabase) => Promise<T>) =>
    withReadBudget(project, () =>
      boundedReadTransaction(database, Date.now() + 15_000, work)
    )

  async function snapshotArtifact(
    datasetId: string,
    versionId: string
  ): Promise<DatasetDetail> {
    return read((db) => snapshotManifest(db, datasetId, versionId))
  }
  async function scorerVersion(
    id: string,
    versionId: string
  ): Promise<EvaluatorVersion> {
    return read(async (db) => {
      await assertRelationBytes(
        db,
        sql`select * from evaluator_versions where project_id=${project} and evaluator_id=${id} and id=${versionId}`
      )
      const result = await db.execute(
        sql`select id,evaluator_id as "evaluatorId",version,language,code,config_json as config,created_at as "createdAt" from evaluator_versions where project_id=${project} and evaluator_id=${id} and id=${versionId}`
      )
      const row = result.rows[0]
      if (!row) throw notFound("Scorer version", versionId)
      return {
        ...row,
        config: row.config ? JSON.parse(String(row.config)) : undefined,
      } as EvaluatorVersion
    })
  }
  return {
    promoteSpans: (raw: PromoteSpansInput): TracerEffect<SpanPromotionResult> =>
      tracerEffect(async () => {
        const input = promoteSpansSchema.parse(raw)
        return database.transaction(
          async (tx) => {
            await tx.execute(sql`set local statement_timeout = '15s'`)
            const scoped = scopedTracerTransaction(database, tx)
            await datasetHeader(scoped, input.datasetId)
            const cases: SpanPromotionResult["cases"] = []
            let caseBytes = 2
            for (const selection of input.spans) {
              const evidence = await captureSpanEvidence(
                scoped,
                selection.traceId,
                selection.spanId
              )
              if (
                selection.copyObservedOutput &&
                selection.expectedOutput !== undefined
              )
                throw validation(
                  "Choose expectedOutput or copyObservedOutput, not both."
                )
              const item: SpanPromotionResult["cases"][number] = {
                ...(selection.id ? { id: selection.id } : {}),
                input:
                  selection.mappedInput === undefined
                    ? evidence.input
                    : selection.mappedInput,
                expectedOutput: selection.copyObservedOutput
                  ? evidence.output
                  : selection.expectedOutput ?? null,
                metadata: selection.metadata ?? {},
                sourceTraceId: selection.traceId,
                sourceSpanId: selection.spanId,
                sourceSpanEvidence: evidence,
                observedOutput: evidence.output,
              }
              cases.push(item)
              caseBytes += Buffer.byteLength(JSON.stringify(item)) + 1
              if (caseBytes > READ_MAX_BYTES)
                throw new TracerError(
                  "READ_RESULT_TOO_LARGE",
                  "Promotion batch exceeds 8 MiB; select fewer spans."
                )
            }
            const evidenceHash = digest(cases)
            if (
              input.expectedEvidenceHash &&
              input.expectedEvidenceHash !== evidenceHash
            )
              throw new TracerError(
                "CONFLICT",
                "Selected evidence changed after preview. Preview the cases again."
              )
            if (
              input.expectedHash &&
              input.expectedHash !==
                (await datasetHash(scoped, input.datasetId)).contentHash
            )
              throw new TracerError(
                "CONFLICT",
                "Dataset changed; refresh before promoting."
              )
            let created: string[] = []
            if (!input.preview) {
              const result = await runTracerEffect(
                serviceFor(scoped).agent.bulkDataset({
                  datasetId: input.datasetId,
                  create: cases.map((item) => ({
                    id: item.id,
                    input: item.input,
                    expectedOutput: item.expectedOutput,
                    metadata: item.metadata,
                    sourceTraceId: item.sourceTraceId,
                    sourceSpanId: item.sourceSpanId,
                  })),
                })
              )
              created = result.created
            }
            return {
              preview: input.preview,
              datasetId: input.datasetId,
              evidenceHash,
              cases,
              created,
            }
          },
          { isolationLevel: "repeatable read" }
        )
      }),
    checkScorerRuntime: (input: { scorerIds: string[]; evaluatorVersionIds?: Record<string, string> }) => tracerEffect(async () => {
      if (!input.scorerIds.length || input.scorerIds.length > 10) throw validation("Select 1–10 scorers for configuration diagnostics.")
      if (Object.keys(input.evaluatorVersionIds ?? {}).some(id => !input.scorerIds.includes(id))) throw validation("Version pins must refer to selected scorers.")
      const checks = []
      for (const id of [...new Set(input.scorerIds)]) {
        const version = input.evaluatorVersionIds?.[id]
          ? await scorerVersion(id, input.evaluatorVersionIds[id])
          : (await runTracerEffect(service().getEvaluator(id))).activeVersion
        checks.push(await scorerReadiness(version, project, database))
      }
      return { mode: "configuration", incurredProviderUsage: false, checks }
    }),
    probeScorerRuntime: (input: { scorerIds: string[]; evaluatorVersionIds?: Record<string, string>; traceId: string; spanId?: string; datasetId?: string; datasetItemId?: string; datasetVersionId?: string }): TracerEffect<{ mode: string; evaluationRunCreated: boolean; checks: import("@/src/lib/tracer/contracts").JsonObject[] }> => tracerEffect(async () => {
      if (!input.scorerIds.length || input.scorerIds.length > 3) throw validation("Select 1–3 scorers for a bounded representative runtime probe.")
      const config = await runTracerEffect(service().agent.checkScorerRuntime(input))
      const checks = []
      const circuit = new RuntimeCircuit()
      for (const check of config.checks) {
        if (check.configuration !== "present") { checks.push(check); continue }
        const result = await circuit.run(JSON.stringify(check.runtime), async () => (await runTracerEffect(service().agent.testScorer({
          ...input, scorerId: String(check.scorerId), versionId: String(check.versionId),
        }, { timeoutMs: 15_000 }))).result)
        const diagnostic = result.metadata?.runtimeDiagnostic as import("@/src/lib/tracer/contracts").JsonObject | undefined
        checks.push({ ...check, authentication: diagnostic?.category === "authorization" ? "failed" : result.error ? "not_verified" : "verified", connectivity: !result.error || diagnostic?.httpStatus ? "verified" : "not_verified", execution: result.error ? "failed" : "succeeded", result: JSON.parse(JSON.stringify(result)) })
      }
      return { mode: "runtime_probe", evaluationRunCreated: false, checks }
    }),
    snapshotArtifact,
    hydrateDatasetItem: <T extends DatasetItemForEvaluation>(item: T) =>
      hydrateDatasetItem(database, item),
    scorerVersion,
    listVersions: (id: string, page: Page) =>
      tracerEffect(() =>
        read(async (db) => {
          const exists = await db.execute(
            sql`select id from evaluators where project_id=${project} and id=${id}`
          )
          if (!exists.rows.length) throw notFound("Scorer", id)
          return collectionSqlPage(
            db,
            sql`select id,evaluator_id as "evaluatorId",version,created_at as "createdAt" from evaluator_versions where project_id=${project} and evaluator_id=${id}`,
            page,
            "version"
          )
        })
      ),
    getVersion: (id: string, versionId: string) =>
      tracerEffect(() => scorerVersion(id, versionId)),
    testScorer: (input: {
      traceId: string
      spanId?: string
      scorerId?: string
      versionId?: string
      scorer?: ScorerInput
      datasetId?: string
      datasetItemId?: string
      datasetVersionId?: string
    }, executionOptions?: { timeoutMs?: number }) =>
      tracerEffect(async () => {
        const version: EvaluatorVersion = input.scorer
          ? {
              id: "preview",
              evaluatorId: "preview",
              version: 0,
              createdAt: new Date().toISOString(),
              language: input.scorer.type === "python" ? "python" : "javascript",
              code: input.scorer.code,
              config: input.scorer,
            }
          : input.versionId
            ? await scorerVersion(input.scorerId!, input.versionId)
            : (await runTracerEffect(service().getEvaluator(input.scorerId!)))
                .activeVersion
        const item = input.datasetId
          ? await read(db => datasetCase(db, input.datasetId!, input.datasetItemId, input.datasetVersionId))
          : undefined
        if (input.datasetItemId && !item)
          throw notFound("Dataset item", input.datasetItemId)
        if (item?.sourceTraceId && item.sourceTraceId !== input.traceId)
          throw validation("Preview trace must match the dataset case source trace.")
        if (input.spanId && item?.sourceSpanId && input.spanId !== item.sourceSpanId)
          throw validation("Preview span must match the dataset case source span.")
        const trace = scorerEvidence(item?.sourceSpanEvidence ?? (input.spanId
          ? await runTracerEffect(service().getSpanEvidence(input.traceId, input.spanId))
          : await invocationEvidence(service(), await runTracerEffect(service().getTraceArtifact(input.traceId)))))
        if (Buffer.byteLength(JSON.stringify(trace)) > READ_MAX_BYTES)
          throw new TracerError("READ_RESULT_TOO_LARGE", "Scorer test evidence exceeds 8 MiB.")
        return {
          traceId: trace.id,
          scorerId: version.evaluatorId,
          versionId: version.id,
          result: await executeScorerWithSpan(service(), { version, trace, datasetItem: item, projectId: project, database, timeoutMs: executionOptions?.timeoutMs }),
          persisted: false,
          mode: "preview",
          evaluationRunCreated: false,
          executionSpanRetained: true,
        }
      }),
    bulkDataset: (input: BulkDatasetInput) =>
      tracerEffect(async () =>
        database.transaction(
          async (tx) => {
            await tx.execute(sql`set local statement_timeout = '15s'`)
            await tx.execute(sql`set local lock_timeout = '2s'`)
            const locked = await tx.execute(
              sql`select id from datasets where project_id=${project} and id=${input.datasetId} for update`
            )
            if (!locked.rows.length) throw notFound("Dataset", input.datasetId)
            const scoped = scopedTracerTransaction(database, tx)
            if (
              input.expectedHash &&
              input.expectedHash !== (await datasetHash(scoped, input.datasetId)).contentHash
            )
              throw new TracerError(
                "CONFLICT",
                "Dataset content changed; refresh its snapshot before editing."
              )
            const ids = [
              ...(input.update ?? []).map((i) => i.id),
              ...(input.delete ?? []),
            ]
            if (new Set(ids).size !== ids.length)
              throw validation(
                "Each existing item may appear only once in a bulk edit."
              )
            if (ids.length) {
              const owned = await scoped.execute(sql`select id from dataset_items where project_id=${project} and dataset_id=${input.datasetId} and id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`)
              if (owned.rows.length !== ids.length) throw validation("All edited items must belong to this dataset.")
            }
            const scopedService = serviceFor(scoped)
            const created: string[] = []
            for (const item of input.create ?? [])
              created.push(
                (
                  await runTracerEffect(
                    scopedService.createDatasetItem(input.datasetId, item)
                  )
                ).id
              )
            for (const item of input.update ?? [])
              await runTracerEffect(
                scopedService.patchDatasetItem(item.id, item.patch)
              )
            for (const id of input.delete ?? [])
              await runTracerEffect(scopedService.deleteDatasetItem(id))
            return {
              datasetId: input.datasetId,
              created,
              updated: (input.update ?? []).map((i) => i.id),
              deleted: input.delete ?? [],
              contentHash: (await datasetHash(scoped, input.datasetId)).contentHash,
            }
          },
          { isolationLevel: "serializable" }
        )
      ),
    createSnapshot: (datasetId: string, label?: string) =>
      tracerEffect(async () =>
        database.transaction(
          async (tx) => {
            await tx.execute(sql`set local statement_timeout = '15s'`)
            return writeSnapshot(scopedTracerTransaction(database, tx), datasetId, label)
          },
          { isolationLevel: "repeatable read" }
        )
      ),
    listSnapshots: (datasetId: string, page: Page) =>
      tracerEffect(() =>
        read(async (db) => {
          const exists = await db.execute(
            sql`select id from datasets where project_id=${project} and id=${datasetId}`
          )
          if (!exists.rows.length) throw notFound("Dataset", datasetId)
          return collectionSqlPage<Snapshot>(
            db,
            sql`select id,dataset_id as "datasetId",content_hash as "contentHash",label,item_count as "itemCount",created_at as "createdAt" from dataset_snapshots where project_id=${project} and dataset_id=${datasetId}`,
            page,
            "createdAt"
          )
        })
      ),
    getSnapshot: (datasetId: string, versionId: string, page: Page) =>
      tracerEffect(() => read(db => snapshotPage(db, datasetId, versionId, page))),
    startEval: (input: CreateEvalRunInput & { requestKey: string }, options?: { background: boolean }) =>
      tracerEffect(async () => {
        const { requestKey, ...runInput } = input
        const hash = digest(runInput)
        const claimed = await database.execute(
          sql`insert into agent_eval_requests(project_id,request_key,request_hash,state) values (${project},${requestKey},${hash},'starting') on conflict do nothing returning request_key`
        )
        if (!claimed.rows.length) {
          const old = await database.execute(
            sql`select request_hash,run_id,state from agent_eval_requests where project_id=${project} and request_key=${requestKey}`
          )
          const row = old.rows[0]
          if (row.request_hash !== hash)
            throw new TracerError(
              "CONFLICT",
              "requestKey was already used with different evaluation inputs."
            )
          if (row.run_id) {
            const run = await runTracerEffect(service().getEvalRun(String(row.run_id)))
            const link = await runTracerEffect(service().agent.resolveObject("eval", run.id))
            return { ...run, url: link.url ?? link.path }
          }
          throw new TracerError(
            "CONFLICT",
            "This request is already starting or was interrupted. Inspect eval runs before explicitly choosing a new requestKey."
          )
        }
        try {
          const run = await runTracerEffect(
            service().createEvalRun({
              ...runInput,
              agentRequestKey: requestKey,
              background: options?.background ?? true,
              metadata: { ...runInput.metadata, agentRequestKey: requestKey },
            })
          )
          await database.execute(
            sql`update agent_eval_requests set state='started',run_id=${run.id} where project_id=${project} and request_key=${requestKey}`
          )
          const link = await runTracerEffect(service().agent.resolveObject("eval", run.id))
          return { ...run, url: link.url ?? link.path }
        } catch (error) {
          await database.execute(
            sql`update agent_eval_requests set state='failed' where project_id=${project} and request_key=${requestKey}`
          )
          throw error
        }
      }),
    gateEval: (input: {
      id: string
      minScore: number
      minPassRate: number
      maxErrors: number
      allowUnscored: boolean
      baselineId?: string
      maxRegression: number
    }) =>
      tracerEffect(() =>
        read(async (db) => {
          async function summary(id: string) {
            const result = await db.execute(
              sql`select r.id,r.status,(select count(*) from eval_run_targets t where t.project_id=${project} and t.run_id=r.id) * (select count(*) from eval_run_evaluators e where e.project_id=${project} and e.run_id=r.id) as expected,count(e.id) as actual,count(*) filter(where e.status='error') as errors,count(*) filter(where e.passed=true) as passed,count(*) filter(where e.passed is not null) as classified,count(*) filter(where e.score is null or e.passed is null) as unscored,avg(e.score) as score from eval_runs r left join eval_results e on e.project_id=r.project_id and e.run_id=r.id where r.project_id=${project} and r.id=${id} group by r.id`
            )
            const row = result.rows[0]
            if (!row) throw notFound("Eval run", id)
            return {
              id,
              status: String(row.status),
              expected: Number(row.expected),
              actual: Number(row.actual),
              errors: Number(row.errors),
              unscored: Number(row.unscored),
              passRate: Number(row.classified)
                ? Number(row.passed) / Number(row.classified)
                : null,
              score: row.score === null ? null : Number(row.score),
            }
          }
          const run = await summary(input.id)
          const reasons: string[] = []
          if (run.status !== "completed") reasons.push(`Run is ${run.status}.`)
          if (!run.expected || run.actual !== run.expected)
            reasons.push("Missing evaluation results or empty run.")
          if (run.errors > input.maxErrors)
            reasons.push("Error count exceeds the limit.")
          if (!input.allowUnscored && run.unscored)
            reasons.push("Unscored, skipped or unclassified results exist.")
          if (run.score === null || run.score < input.minScore)
            reasons.push("Mean score is missing or below the minimum.")
          if (run.passRate === null || run.passRate < input.minPassRate)
            reasons.push("Pass rate is missing or below the minimum.")
          const baseline = input.baselineId
            ? await summary(input.baselineId)
            : null
          if (
            baseline &&
            (baseline.status !== "completed" ||
              !baseline.expected ||
              baseline.actual !== baseline.expected ||
              baseline.errors ||
              baseline.unscored ||
              baseline.score === null ||
              run.score === null ||
              baseline.score - run.score > input.maxRegression)
          )
            reasons.push(
              "Baseline is incomplete or mean score regression exceeds the limit."
            )
          if (baseline) {
            const population = await db.execute(sql`with populations as (
          select r.id,
            (select jsonb_agg(jsonb_build_array(e.evaluator_id,e.evaluator_version_id) order by e.evaluator_id) from eval_run_evaluators e where e.project_id=${project} and e.run_id=r.id) as scorers,
            (select jsonb_agg(c.value order by c.value::text) from (
              select jsonb_build_object('input',t.snapshot_json::jsonb #> '{trace,input}','item',t.snapshot_json::jsonb #> '{datasetItem,id}','expected',t.snapshot_json::jsonb #> '{datasetItem,expectedOutput}') as value
              from eval_run_targets t where t.project_id=${project} and t.run_id=r.id
            ) c) as cases
          from eval_runs r where r.project_id=${project} and r.id in (${input.id},${baseline.id})
        ) select a.scorers=b.scorers and a.cases=b.cases as comparable from populations a join populations b on a.id=${input.id} and b.id=${baseline.id}`)
            if (population.rows[0]?.comparable !== true)
              reasons.push(
                "Baseline must use the same scorer versions, inputs and expected outputs."
              )
          }
          return {
            passed: reasons.length === 0,
            reasons,
            run,
            baseline,
            thresholds: input,
          }
        })
      ),
    previewDashboard: (id: string) =>
      tracerEffect(async () => {
        const dashboard = await runTracerEffect(service().dashboards.get(id))
        const plan = dashboardQueryPlan(
          dashboard.widgets.flatMap((widget) => [
            {
              ...widget,
              id: `aggregate:${widget.id}`,
              type: "table" as const,
              compare: undefined,
            },
            ...(widget.compare
              ? [
                  {
                    ...widget,
                    id: `comparison:${widget.id}`,
                    type: "table" as const,
                  },
                ]
              : []),
          ]),
          {}
        )
        const data: SemanticResult[] = []
        for (const queries of plan.batches)
          data.push(
            ...(await runTracerEffect(
              service().batchSemanticMetrics({ queries })
            ))
          )
        return {
          dashboard,
          results: plan.positions
            .filter((position) => position.id.startsWith("aggregate:"))
            .map((position) => data[position.cohorts[0].result]),
          comparisons: plan.positions
            .filter((position) => position.id.startsWith("comparison:"))
            .map((position) => ({
              widgetId: position.id.slice("comparison:".length),
              cohorts: position.cohorts.map((cohort) => ({
                label: cohort.label,
                result: data[cohort.result],
              })),
            })),
        }
      }),
    resolveObject: (
      kind:
        | "trace"
        | "session"
        | "dataset"
        | "scorer"
        | "eval"
        | "dashboard"
        | "view",
      key: string
    ) =>
      tracerEffect(async () => {
        const catalogs = {
          trace: "traces",
          session: "sessions",
          dataset: "datasets",
          scorer: "scorers",
          eval: "eval_runs",
          dashboard: "dashboards",
          view: "saved_views",
        } as const
        const table = sql.identifier(catalogs[kind])
        const match =
          kind === "scorer"
            ? sql`id=${key} or slug=${key}`
            : ["trace", "session", "dataset", "eval", "view"].includes(kind)
              ? sql`id=${key} or name=${key}`
              : sql`id=${key}`
        return read(async (db) => {
          const found = await db.execute(
            sql`select id from ${table} where project_id=${project} and (${match}) order by (id=${key}) desc,id limit 2`
          )
          if (!found.rows.length) throw notFound(kind, key)
          if (found.rows.length > 1 && found.rows[0].id !== key)
            throw new TracerError(
              "CONFLICT",
              "Name is ambiguous; use an exact ID."
            )
          const id = String(found.rows[0].id)
          const scope = await db.execute(
            sql`select slug as project from project where id=${project}`
          )
          const slugs = scope.rows[0]
          if (!slugs) throw notFound("Project", project)
          const prefix = `/p/${encodeURIComponent(String(slugs.project))}`
          const path = {
            trace: `/traces/${encodeURIComponent(id)}`,
            session: `/sessions/${encodeURIComponent(id)}`,
            dataset: `/datasets/${encodeURIComponent(id)}`,
            scorer: "/scorers",
            eval: `/evals/${encodeURIComponent(id)}`,
            dashboard: "/dashboards",
            view: "/traces",
          }[kind]
          return {
            kind,
            id,
            projectId: project,
            path: prefix + path,
            url: process.env.BETTER_AUTH_URL
              ? new URL(prefix + path, process.env.BETTER_AUTH_URL).href
              : null,
            linkKind: ["scorer", "dashboard", "view"].includes(kind)
              ? "collection"
              : "detail",
          }
        })
      }),
  }
}

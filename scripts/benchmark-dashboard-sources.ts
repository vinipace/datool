/** Local, schema-isolated backend benchmark. No application/production data. */
import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, writeFile } from "node:fs/promises"
import { cpus, totalmem } from "node:os"
import { dirname } from "node:path"
import { sql, type SQL } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "../tests/helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "../tests/helpers/eval-attribution-fixture"
import { semanticCatalog } from "../src/server/metrics/registry"
import { executeSemanticBatch } from "../src/server/semantic/executor"
import {
  createSemanticSnapshotRunner,
  type SemanticSnapshotRunner,
} from "../src/server/semantic/snapshot"
import { readTelemetry } from "../src/server/semantic/telemetry"
import { toSemanticServiceError } from "../src/server/semantic/errors"
import { dashboardTemplates } from "../src/lib/tracer/dashboard-templates"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"
import {
  semanticQuerySchema,
  type NormalizedSemanticQuery,
} from "../src/lib/semantic/query"
import { boundedInteger, localEndpoint } from "./read-load/safety"

const databaseUrl = process.env.DATOOL_TEST_DATABASE_URL
if (!databaseUrl)
  throw new Error("Set an explicit disposable DATOOL_TEST_DATABASE_URL.")
localEndpoint(databaseUrl, ["postgres:", "postgresql:"])
const scales = (process.env.DATOOL_DASHBOARD_PERF_SCALES ?? "1,10")
  .split(",")
  .map((s) => boundedInteger(s, 1, 1, 25))
const repetitions = boundedInteger(
  process.env.DATOOL_DASHBOARD_PERF_REPETITIONS,
  12,
  3,
  100
)
const concurrentRequests = boundedInteger(
  process.env.DATOOL_DASHBOARD_PERF_REQUESTS,
  16,
  8,
  100
)
const concurrencyLevels = (
  process.env.DATOOL_DASHBOARD_PERF_CONCURRENCY ?? "1,2,4,8"
)
  .split(",")
  .filter(Boolean)
  .map((value) => boundedInteger(value, 1, 1, 8))
const jit = process.env.DATOOL_DASHBOARD_PERF_JIT
if (jit !== undefined && jit !== "on" && jit !== "off")
  throw new Error("DATOOL_DASHBOARD_PERF_JIT must be on or off.")
const output =
  process.env.DATOOL_DASHBOARD_PERF_OUTPUT ??
  ".tmp/dashboard-source-performance.json"
const round = (n: number) => Math.round(n * 100) / 100
const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length
    ? round(sorted[Math.ceil(sorted.length * fraction) - 1])
    : null
}
type Measurement = {
  elapsedMs: number
  rows: number
  bytes: number
  outcome: string
}
type Sample = {
  elapsedMs: number
  sqlMs: number
  statements: number
  rows: number
  sqlBytes: number
  responseBytes: number
  error?: string
}
type Workload = { name: string; batches: NormalizedSemanticQuery[][] }
const sampleContext = new AsyncLocalStorage<Measurement[]>()
const collect = (event: unknown) =>
  sampleContext.getStore()?.push(event as Measurement)
readTelemetry.subscribe(collect)
const summarize = (samples: Sample[]) => ({
  requests: samples.length,
  succeeded: samples.filter((s) => !s.error).length,
  errors: samples
    .filter((s) => s.error)
    .reduce<Record<string, number>>((all, s) => {
      all[s.error!] = (all[s.error!] ?? 0) + 1
      return all
    }, {}),
  p50Ms: quantile(
    samples.filter((s) => !s.error).map((s) => s.elapsedMs),
    0.5
  ),
  p95Ms: quantile(
    samples.filter((s) => !s.error).map((s) => s.elapsedMs),
    0.95
  ),
  maxMs: quantile(
    samples.map((s) => s.elapsedMs),
    1
  ),
  sqlP50Ms: quantile(
    samples.filter((s) => !s.error).map((s) => s.sqlMs),
    0.5
  ),
  maxStatements: Math.max(0, ...samples.map((s) => s.statements)),
  maxReturnedRows: Math.max(0, ...samples.map((s) => s.rows)),
  maxSqlBytes: Math.max(0, ...samples.map((s) => s.sqlBytes)),
  maxResponseBytes: Math.max(0, ...samples.map((s) => s.responseBytes)),
})
const report = {
  startedAt: new Date().toISOString(),
  environment: {
    runtime: process.version,
    bun: process.versions.bun,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    hostMemoryGiB: round(totalmem() / 1024 ** 3),
  },
  method: {
    repetitions,
    warmups: 2,
    concurrentRequests,
    concurrency: concurrencyLevels,
    jit: jit ?? "application snapshot default (off)",
    cache:
      "Warm database/OS caches after seed and VACUUM ANALYZE; no application result cache",
    scope:
      "Semantic service, SQL, snapshot and admission overhead. Excludes HTTP/auth/network/browser rendering; closed-loop concurrency, not an arrival-rate capacity test.",
    safety:
      "Disposable loopback database; unique schema dropped in finally. Existing 2-slot analytics admission, 2s queue, 10s statement and 15s batch deadlines retained.",
  },
  datasets: [] as Record<string, unknown>[],
  peakProcessRssMiB: 0,
}
const memoryTimer = setInterval(() => {
  report.peakProcessRssMiB = Math.max(
    report.peakProcessRssMiB,
    round(process.memoryUsage().rss / 1024 ** 2)
  )
}, 100)
const save = async () => {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + "\n")
}

try {
  for (const scale of scales) {
    const db = await createTracerFixture()
    const dataset: Record<string, unknown> = {
      scale,
      traces: 4000 * scale + 1,
      spans: 20000 * scale,
      runs: 1000 * scale,
      results: 5000 * scale,
      ratings: 5000 * scale,
      attributions: 10000 * scale,
    }
    report.datasets.push(dataset)
    try {
      const seedStart = performance.now()
      console.info(JSON.stringify({ event: "seed", ...dataset }))
      const { project, scorer, now } = await seedEvalAttributionFacts(
        db,
        1000 * scale,
        5
      )
      const timestamp = now.toISOString()
      await db.execute(sql`insert into eval_run_evaluators(id,project_id,run_id,evaluator_id,evaluator_version_id)
        select 'expected-'||r.id,${project},r.id,${scorer.id},e.active_version_id from eval_runs r join evaluators e on e.project_id=r.project_id and e.id=${scorer.id} where r.project_id=${project}`)
      await db.execute(sql`insert into traces(project_id,id,name,operation,status,started_at,ended_at,group_type,group_name,group_version,attributes_json)
        select ${project},'perf-trace-'||i,'Request '||(i%100),'workflow','completed',
          to_char(${timestamp}::timestamptz-(i%30)*interval '1 day'-interval '2 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(${timestamp}::timestamptz-(i%30)*interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'workflow','Workflow '||(i%100),'v'||(i%3),jsonb_build_object('user.id','user-'||(i%1000)) from generate_series(1,${4000 * scale}) i`)
      await db.execute(sql`insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
        select ${project},'perf-span-'||i||'-'||s,'perf-trace-'||i,'Generate '||(i%100),'llm','completed',
          to_char(${timestamp}::timestamptz-(i%30)*interval '1 day'-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          to_char(${timestamp}::timestamptz-(i%30)*interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          jsonb_build_object('cost.usd',(i%7)::float/100,'gen_ai.response.model','model-'||((i+s)%20),'gen_ai.usage.input_tokens',100,'gen_ai.usage.output_tokens',50,'ttft.ms',i%200,'ai.telemetry.functionId','Generate '||(i%100))
        from generate_series(1,${4000 * scale}) i cross join generate_series(1,5) s`)
      // Separate seed work from measurement; only this fixture's tables are touched.
      for (const table of [
        "traces",
        "spans",
        "trace_group_memberships",
        "eval_runs",
        "eval_run_targets",
        "eval_run_evaluators",
        "eval_results",
        "eval_target_attributions",
        "scores",
        "review_scores",
      ])
        await db.execute(sql`vacuum (analyze) ${sql.identifier(table)}`)
      dataset.seedMs = round(performance.now() - seedStart)
      dataset.postgres = (
        await db.execute(
          sql`select version(),current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem,current_setting('jit') as jit`
        )
      ).rows[0]
      const range = [
        new Date(now.getTime() - 30 * 86400000).toISOString(),
        new Date(now.getTime() + 1000).toISOString(),
      ]
      const query = (
        model: string,
        measures: string[],
        dimensions: string[] = [],
        daily = false
      ) =>
        semanticQuerySchema.parse({
          measures: measures.map((m) => `${model}.${m}`),
          dimensions: dimensions.map((d) => `${model}.${d}`),
          timeDimensions: [
            {
              dimension: `${model}.${model === "evalRuns" ? "createdAt" : model === "evalResults" ? "completedAt" : model === "scoreValues" ? "recordedAt" : "startedAt"}`,
              dateRange: range,
              ...(daily ? { granularity: "day" } : {}),
            },
          ],
          order: [[`${model}.${measures[0]}`, "desc"]],
          limit: 1000,
          total: true,
        })
      const single = (name: string, q: NormalizedSemanticQuery): Workload => ({
        name,
        batches: [[q]],
      })
      const workloads: Workload[] = [
        single(
          "Spans: daily cost by model",
          query("spans", ["costUsd", "llmCount"], ["model"], true)
        ),
        single(
          "Spans: attributed cost ranking",
          query("spans", ["costUsd"], ["workflowName"])
        ),
        single(
          "Traces: daily child usage and latency",
          query(
            "traces",
            ["costUsd", "llmCount", "meanDurationMs", "p95DurationMs"],
            [],
            true
          )
        ),
        single(
          "Evaluation Runs: case coverage",
          query(
            "evalRuns",
            [
              "count",
              "resultCount",
              "selectedTargetCount",
              "executionCoverage",
              "completionCoverage",
            ],
            [],
            true
          )
        ),
        single(
          "Evaluation Results: saved workflow/model quality",
          query(
            "evalResults",
            ["executionCount", "meanScore"],
            ["groupName", "model"]
          )
        ),
        single(
          "Scores: numeric values by definition",
          query("scoreValues", ["count", "meanValue"], ["definitionId"], true)
        ),
      ]
      for (const id of ["cost-and-usage", "eval-quality-by-model"]) {
        const template = dashboardTemplates.find((t) => t.id === id)!
        const dashboard = template.create(new Date(now.getTime() + 1000))
        const widgets = dashboard.widgets.map((w) => ({
          ...w,
          query: {
            ...w.query,
            timeDimensions: w.query.timeDimensions.map((t) => ({
              ...t,
              dateRange: range as [string, string],
            })),
          },
        }))
        workloads.push({
          name: `Dashboard: ${template.name} (${widgets.length} widgets)`,
          batches: dashboardQueryPlan(widgets, {}).batches,
        })
      }
      const baseRunner = createSemanticSnapshotRunner(db)
      const runner: SemanticSnapshotRunner = (callback) =>
        baseRunner(async (snapshot, asOf) => {
          if (jit !== undefined)
            await snapshot.execute(sql`select set_config('jit',${jit},true)`)
          return callback(snapshot, asOf)
        })
      const options = {
        catalog: semanticCatalog,
        requestId: "source-perf",
        snapshotRunner: runner,
      }
      const runWorkload = async (
        workload: Workload,
        snapshotRunner = runner
      ) => {
        const results = []
        for (const queries of workload.batches)
          results.push(
            ...(await executeSemanticBatch(
              { queries },
              { ...options, snapshotRunner }
            ))
          )
        return results
      }
      // Independent fixture invariants ensure that performance isn't obtained by dropping facts.
      const totals = await executeSemanticBatch(
        {
          queries: [
            query("spans", ["spanCount", "costUsd"]),
            query("traces", ["count", "costUsd"]),
            query("evalRuns", ["count", "completionCoverage"]),
            query("evalResults", ["executionCount"]),
            query("scoreValues", ["count"]),
          ],
        },
        options
      )
      assert.equal(totals[0].data[0]["spans.spanCount"], dataset.spans)
      assert.equal(totals[1].data[0]["traces.count"], dataset.traces)
      assert(
        Math.abs(
          Number(totals[0].data[0]["spans.costUsd"]) -
            Number(totals[1].data[0]["traces.costUsd"])
        ) < 1e-7
      )
      assert.equal(totals[2].data[0]["evalRuns.count"], dataset.runs)
      assert.equal(totals[2].data[0]["evalRuns.completionCoverage"], 1)
      assert.equal(
        totals[3].data[0]["evalResults.executionCount"],
        dataset.results
      )
      assert.equal(totals[4].data[0]["scoreValues.count"], dataset.ratings)
      dataset.correctness = "passed"
      const measure = async (workload: Workload): Promise<Sample> => {
        const events: Measurement[] = [],
          started = performance.now()
        let responseBytes = 0,
          error: string | undefined
        await sampleContext.run(events, async () => {
          try {
            responseBytes = Buffer.byteLength(
              JSON.stringify(await runWorkload(workload))
            )
          } catch (failure) {
            const translated = toSemanticServiceError(failure)
            error =
              "code" in translated ? String(translated.code) : translated.name
          }
        })
        return {
          elapsedMs: round(performance.now() - started),
          sqlMs: round(events.reduce((n, e) => n + e.elapsedMs, 0)),
          statements: events.length,
          rows: events.reduce((n, e) => n + e.rows, 0),
          sqlBytes: events.reduce((n, e) => n + e.bytes, 0),
          responseBytes,
          ...(error ? { error } : {}),
        }
      }
      const sequential: Record<string, unknown>[] = []
      dataset.sequential = sequential
      for (const workload of workloads) {
        const warmups = [await measure(workload), await measure(workload)]
        const samples = []
        for (let i = 0; i < repetitions; i++)
          samples.push(await measure(workload))
        const row = {
          name: workload.name,
          semanticQueries: workload.batches.flat().length,
          ...summarize(samples),
          warmups,
          samples,
        }
        sequential.push(row)
        console.info(
          JSON.stringify({
            event: "sequential",
            scale,
            name: row.name,
            p50Ms: row.p50Ms,
            p95Ms: row.p95Ms,
            errors: row.errors,
          })
        )
        await save()
      }
      const concurrent: Record<string, unknown>[] = []
      dataset.concurrent = concurrent
      const dashboard = workloads.find((w) =>
        w.name.startsWith("Dashboard: Cost")
      )!
      for (const clients of concurrencyLevels) {
        const started = performance.now(),
          samples: Sample[] = []
        let next = 0
        await Promise.all(
          Array.from({ length: clients }, async () => {
            while (next++ < concurrentRequests)
              samples.push(await measure(dashboard))
          })
        )
        const elapsedMs = performance.now() - started
        const row = {
          clients,
          name: dashboard.name,
          ...summarize(samples),
          elapsedMs: round(elapsedMs),
          successfulRefreshesPerSecond: round(
            samples.filter((s) => !s.error).length / (elapsedMs / 1000)
          ),
          samples,
        }
        concurrent.push(row)
        console.info(
          JSON.stringify({
            event: "concurrent",
            scale,
            clients,
            p50Ms: row.p50Ms,
            p95Ms: row.p95Ms,
            errors: row.errors,
            successfulRefreshesPerSecond: row.successfulRefreshesPerSecond,
          })
        )
        await save()
      }
      // Capture the real executed queries once, outside timed samples.
      const plans: Record<string, unknown>[] = []
      dataset.plans = plans
      for (const workload of workloads.slice(0, 6)) {
        const statements: SQL[] = []
        const capturing: SemanticSnapshotRunner = (callback) =>
          runner((snapshot, asOf) =>
            callback(
              {
                ...snapshot,
                execute: ((statement: SQL) => {
                  statements.push(statement)
                  return snapshot.execute(statement)
                }) as typeof snapshot.execute,
              },
              asOf
            )
          )
        try {
          await runWorkload(workload, capturing)
          for (const statement of statements) {
            const explained = await runner((snapshot) =>
              snapshot.execute(
                sql`explain (analyze,buffers,format json) ${statement}`
              )
            )
            plans.push({
              workload: workload.name,
              plan: explained.rows[0]["QUERY PLAN"],
            })
          }
        } catch (failure) {
          plans.push({
            workload: workload.name,
            error: toSemanticServiceError(failure).name,
          })
        }
      }
    } finally {
      await closeTracerFixture(db)
      dataset.schemaRemoved = true
      await save()
    }
  }
} finally {
  clearInterval(memoryTimer)
  readTelemetry.unsubscribe(collect)
  await save()
}
console.info(
  JSON.stringify({
    event: "complete",
    output,
    peakProcessRssMiB: report.peakProcessRssMiB,
  })
)

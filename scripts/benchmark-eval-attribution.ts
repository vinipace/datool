/** Disposable, loopback-only synthetic benchmark. Never uses DATABASE_URL. */
import { writeFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "../tests/helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "../tests/helpers/eval-attribution-fixture"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { dashboardTemplates } from "../src/lib/tracer/dashboard-templates"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"
import { executeSemanticBatch } from "../src/server/semantic/executor"
import { semanticCatalog } from "../src/server/metrics/registry"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import { readTelemetry } from "../src/server/semantic/telemetry"

const db = await createTracerFixture()
try {
  const { now, project } = await seedEvalAttributionFacts(db, 10_000)
  for (const table of [
    "eval_runs",
    "eval_run_groups",
    "eval_run_targets",
    "eval_results",
    "eval_target_attributions",
    "scores",
    "evaluators",
    "evaluator_versions",
  ])
    await db.execute(sql`analyze ${sql.identifier(table)}`)
  const service = new TracerService(db)
  const queries = dashboardQueryPlan(
    dashboardTemplates
      .find((t) => t.id === "eval-quality-by-model")!
      .create(new Date(now.getTime() + 1000)).widgets,
    {}
  ).batches.flat()
  const samples: Record<
    string,
    {
      firstMs: number
      medianMs: number
      maxMs: number
      aggregateStatements?: number
    }
  > = {}
  for (const [name, operation] of [
    [
      "listFirst50",
      () => run(service.listEvalRuns({ limit: 50, includeTotal: true })),
    ],
    [
      "filteredFirst50",
      () =>
        run(
          service.listEvalRuns({
            filter: 'workflow = "Workflow 2"',
            limit: 50,
            includeTotal: true,
          })
        ),
    ],
    [
      "allWorkflowGroups",
      () =>
        run(
          service.listEvalRunGroups({
            groupBy: "workflow",
            limit: 50,
            includeTotal: true,
          })
        ),
    ],
    [
      "entireDashboard",
      () =>
        executeSemanticBatch(
          { queries },
          {
            catalog: semanticCatalog,
            requestId: "benchmark",
            snapshotRunner: createSemanticSnapshotRunner(db),
          }
        ),
    ],
  ] as const) {
    const durations: number[] = []
    let statements = 0
    const count = () => statements++
    readTelemetry.subscribe(count)
    try {
      for (let i = 0; i < 6; i++) {
        const start = performance.now()
        await operation()
        durations.push(performance.now() - start)
      }
    } finally {
      readTelemetry.unsubscribe(count)
    }
    const warm = durations.slice(1).sort((a, b) => a - b)
    samples[name] = {
      firstMs: Math.round(durations[0]),
      medianMs: Math.round(warm[2]),
      maxMs: Math.round(Math.max(...durations)),
      ...(name === "entireDashboard"
        ? { aggregateStatements: statements / 6 }
        : {}),
    }
  }
  const plan =
    await db.execute(sql`explain (analyze,buffers,format json) select r.id,a.group_name from eval_results r
    join eval_target_attributions a on a.project_id=${project} and a.run_id=r.run_id and a.target_id=r.target_id
    where r.project_id=${project} and r.run_id='run-2'`)
  const evidence = {
    dataset: {
      runs: 10000,
      results: 50000,
      attributions: 100000,
      groups: 20000,
    },
    samples,
    targetJoinPlan: plan.rows[0],
  }
  await writeFile(
    "/private/tmp/datool-eval-attribution-benchmark.json",
    JSON.stringify(evidence, null, 2)
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await closeTracerFixture(db)
}

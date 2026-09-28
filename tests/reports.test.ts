import { captureFixtureDocument } from "./helpers/report-document"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createReportService } from "../src/server/tracer/reports"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import {
  closeTracerDatabase,
  getTracerProjectId,
  registerTracerProjectId,
} from "../src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import {
  dashboardInputSchema,
  dashboardDataWidgetSchema,
  newDashboardTextWidget,
  newDashboardWidget,
} from "../src/lib/tracer/dashboards"
import { reportTemplates } from "../src/lib/tracer/report-templates"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"
import { dashboardMatrix } from "../src/lib/tracer/dashboard-matrix"
import {
  frozenReportPage,
  type ReportCaptureInput as ReportInput,
} from "../src/lib/tracer/reports"
import { semanticCatalog } from "../src/server/metrics/registry"
import { executeSemanticQuery } from "../src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import { routeScopes } from "../src/server/auth/request"

test("report routes require dashboard and metric access", async () => {
  expect(
    await routeScopes(new Request("http://localhost/api/reports"))
  ).toEqual(["dashboards:read", "metrics:read"])
  expect(
    await routeScopes(new Request("http://localhost/api/reports/12"))
  ).toEqual(["dashboards:read", "metrics:read"])
  expect(
    await routeScopes(
      new Request("http://localhost/api/reports", { method: "POST" })
    )
  ).toEqual(["dashboards:write", "metrics:read"])
})

async function rejects(promise: Promise<unknown>, message: string) {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain(message)
}

function textReport(): ReportInput {
  return {
    creationKey: crypto.randomUUID(),
    templateId: "custom",
    config: {
      schemaVersion: 1,
      name: "Release notes",
      description: "Frozen findings",
      widgets: [
        {
          ...newDashboardTextWidget(),
          content: "## Findings\n\nKeep this evidence.",
        },
      ],
    },
  }
}

test("report templates share the dashboard contract and text issues no queries", () => {
  for (const template of reportTemplates)
    expect(dashboardInputSchema.safeParse(template.create()).success).toBe(true)
  expect(dashboardQueryPlan(textReport().config.widgets, {}).batches).toEqual(
    []
  )
  const matrix = dashboardDataWidgetSchema.parse(
    reportTemplates[0].create().widgets[1]
  )
  expect(
    dashboardDataWidgetSchema.safeParse({
      ...matrix,
      query: { ...matrix.query, dimensions: ["evalResults.promptVersion"] },
    }).success
  ).toBe(false)
  expect(
    dashboardDataWidgetSchema.safeParse({
      ...matrix,
      query: {
        ...matrix.query,
        measures: ["evalResults.meanScore", "evalResults.p50Score"],
      },
    }).success
  ).toBe(false)
})

test("matrix preserves zeros and missing cells, and refuses duplicate aggregated cells", () => {
  const pivot = dashboardMatrix(
    [
      { prompt: "v1", dataset: "A", score: 0 },
      { prompt: "v2", dataset: "B", score: null },
    ],
    ["prompt", "dataset"],
    "score"
  )
  expect([...pivot.cells.values()]).toEqual([0, null])
  expect(pivot.cells.size).toBe(2)
  expect(pivot.rows).toHaveLength(2)
  expect(pivot.columns).toHaveLength(2)
  expect(() =>
    dashboardMatrix(
      [
        { prompt: "v1", dataset: "A", score: 0 },
        { prompt: "v1", dataset: "A", score: 1 },
      ],
      ["prompt", "dataset"],
      "score"
    )
  ).toThrow("duplicate cells")
})

test("reports persist one complete snapshot and page locally after source changes", async () => {
  const db = await createTracerFixture()
  try {
    await seedEvalAttributionFacts(db, 1, 25)
    const service = createReportService(db)
    const template = reportTemplates[0].create(new Date(Date.now() + 1000))
    const table = dashboardDataWidgetSchema.parse(template.widgets[3])
    table.query.dimensions = ["evalResults.targetId"]
    table.query.limit = 10
    const input: ReportInput = {
      creationKey: crypto.randomUUID(),
      templateId: "evaluation-comparison",
      config: {
        ...template,
        widgets: [template.widgets[0], table, template.widgets[1]],
      },
    }
    const report = await run(service.create(captureFixtureDocument(input)))
    expect(report.number).toBe(1)
    expect(report.snapshot.results).toHaveLength(2)
    expect(
      new Set(report.snapshot.results.map((result) => result.meta.asOf)).size
    ).toBe(1)
    const result = report.snapshot.results[0]
    expect(result.data).toHaveLength(25)
    expect(frozenReportPage(result, 10, 20).data).toEqual(result.data.slice(20))
    expect(frozenReportPage(result, 10, 20).meta.page.total).toBe(25)
    await db.execute(sql`update scores set value=1`)
    await db.execute(sql`delete from eval_results`)
    expect(await run(service.get(1))).toEqual(report)
    expect(await run(service.create(captureFixtureDocument(input)))).toEqual(
      report
    )
    const reopened = reopenTracerFixture(db)
    try {
      expect(await run(createReportService(reopened).get(1))).toEqual(report)
    } finally {
      await closeTracerDatabase(reopened)
    }
    const summaries = await run(service.list())
    expect(summaries).toHaveLength(1)
    expect("snapshot" in summaries[0]).toBe(false)
    expect("config" in summaries[0]).toBe(false)
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

test("matrix overall averages weight source observations and remain frozen", async () => {
  const db = await createTracerFixture()
  try {
    await seedEvalAttributionFacts(db, 1, 5)
    const project = getTracerProjectId(db)
    const now = new Date().toISOString()
    await db.execute(
      sql`insert into datasets(id,project_id,name,created_at,updated_at) values('coverage',${project},'Coverage',${now},${now})`
    )
    await db.execute(
      sql`insert into dataset_items(id,project_id,dataset_id,input_json,created_at,updated_at) select id,${project},'coverage','{}',${now},${now} from (values('A'),('B'),('C')) items(id)`
    )
    await db.execute(
      sql`update eval_results set dataset_item_id=case when target_id='target-1-1' then 'A' when target_id='target-1-5' then 'C' else 'B' end, score=case when target_id='target-1-1' then 0 when target_id='target-1-5' then null else 1 end`
    )
    await db.execute(
      sql`update scores s set value=r.score from eval_results r where r.id=s.eval_result_id and r.project_id=s.project_id`
    )
    const widget = dashboardDataWidgetSchema.parse({
      ...reportTemplates[0].create(new Date(Date.now() + 1000)).widgets[1],
      presentation: { showSummary: true },
    })
    widget.query.dimensions = ["evalResults.runId", "evalResults.datasetItemId"]
    widget.query.order = []
    const input = textReport()
    input.config.widgets = [widget]
    const service = createReportService(db)
    const report = await run(service.create(captureFixtureDocument(input)))
    const cohort = report.snapshot.positions.find((p) =>
      p.id.startsWith("mdx-widget-")
    )!.cohorts[0]
    const cells = report.snapshot.results[cohort.result]
    const summary = report.snapshot.results[cohort.summary!]
    expect(cells.data.map((r) => r["evalResults.meanScore"]).sort()).toEqual(
      [0, 1, null].sort()
    )
    expect(summary.data[0]["evalResults.meanScore"]).toBe(0.75)
    expect(summary.meta.asOf).toBe(cells.meta.asOf)
    expect(summary.meta.page.total).toBe(1)
    await db.execute(sql`update scores set value=0`)
    expect(await run(service.get(report.number))).toEqual(report)
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

test("generation is idempotent, numbers are atomic and reports stay project scoped", async () => {
  const db = await createTracerFixture()
  const other = reopenTracerFixture(db)
  try {
    const project = getTracerProjectId(db)
    const otherProject = crypto.randomUUID()
    await db.execute(sql`insert into project(id,organization_id,name,slug,created_at,updated_at)
      select ${otherProject},organization_id,'Other','other',created_at,updated_at from project where id=${project}`)
    registerTracerProjectId(other, otherProject)
    const service = createReportService(db)
    const input = textReport()
    const [a, b] = await Promise.all([
      run(service.create(captureFixtureDocument(input))),
      run(service.create(captureFixtureDocument(input))),
    ])
    expect(a.id).toBe(b.id)
    const reports = await Promise.all(
      Array.from({ length: 3 }, () =>
        run(service.create(captureFixtureDocument(textReport())))
      )
    )
    expect(reports.map((r) => r.number).sort()).toEqual([2, 3, 4])
    await rejects(
      run(
        service.create(
          captureFixtureDocument({
            ...input,
            config: { ...input.config, name: "Different" },
          })
        )
      ),
      "generation key"
    )
    const otherService = createReportService(other)
    expect(await run(otherService.list())).toEqual([])
    await rejects(run(otherService.get(1)), "not found")
    expect(
      (await run(otherService.create(captureFixtureDocument(input)))).number
    ).toBe(1)
    expect((await run(service.get(1))).id).toBe(a.id)
    await rejects(run(service.get(NaN)), "positive report number")
  } finally {
    await closeTracerDatabase(other)
    await closeTracerFixture(db)
  }
}, 30000)

test("prompt groups and percentiles count each result once despite multiple operation memberships", async () => {
  const db = await createTracerFixture()
  try {
    await seedEvalAttributionFacts(db, 1, 5)
    await db.execute(
      sql`update eval_target_attributions set prompt_versions_json='[{"id":"answer","slug":"answer","version":2}]'::jsonb where target_id <> 'target-1-5'`
    )
    const table = dashboardDataWidgetSchema.parse(
      reportTemplates[0].create(new Date(Date.now() + 1000)).widgets[3]
    )
    const result = await executeSemanticQuery(
      {
        ...table.query,
        dimensions: ["evalResults.promptVersion"],
        order: [["evalResults.promptVersion", "asc"]],
      },
      {
        catalog: semanticCatalog,
        snapshotRunner: createSemanticSnapshotRunner(db),
        requestId: "prompt-percentiles",
      }
    )
    const recorded = result.data.find(
      (row) => row["evalResults.promptVersion"] === "answer v2"
    )!
    expect(recorded["evalResults.scoredCount"]).toBe(4)
    expect(
      Math.abs(Number(recorded["evalResults.meanScore"]) - 0.25) < 1e-9
    ).toBe(true)
    expect(
      Math.abs(Number(recorded["evalResults.p50Score"]) - 0.25) < 1e-9
    ).toBe(true)
    expect(
      Math.abs(Number(recorded["evalResults.p95Score"]) - 0.385) < 1e-9
    ).toBe(true)
    expect(
      result.data.find((row) => row["evalResults.promptVersion"] === null)?.[
        "evalResults.scoredCount"
      ]
    ).toBe(1)
    await db.execute(
      sql`update eval_target_attributions set prompt_versions_json=prompt_versions_json || '[{"id":"answer","slug":"answer","version":3}]'::jsonb where target_id='target-1-1'`
    )
    const mixed = await executeSemanticQuery(
      { ...table.query, dimensions: ["evalResults.promptVersion"] },
      {
        catalog: semanticCatalog,
        snapshotRunner: createSemanticSnapshotRunner(db),
        requestId: "multiple-prompts",
      }
    )
    expect(
      mixed.data.find(
        (row) => row["evalResults.promptVersion"] === "Multiple prompt versions"
      )?.["evalResults.scoredCount"]
    ).toBe(1)
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

test("generation rejects incomplete captures without persisting a report or consuming a number", async () => {
  const db = await createTracerFixture()
  try {
    const project = getTracerProjectId(db)
    const now = new Date()
    await db.execute(sql`insert into traces(id,project_id,name,operation,status,started_at,input_json,output_json,attributes_json)
      select 'trace-' || i,${project},'Trace ' || i,'workflow','completed',${now.toISOString()},'{}','{}','{}' from generate_series(1,5001) i`)
    const widget = newDashboardWidget(
      semanticCatalog.metadata().models.find((m) => m.name === "traces")!,
      new Date(now.getTime() + 1000)
    )
    widget.type = "table"
    widget.query.dimensions = ["traces.traceName"]
    const input = textReport()
    input.config.widgets = [widget]
    const service = createReportService(db)
    await rejects(
      run(service.create(captureFixtureDocument(input))),
      "5,000 rows"
    )
    expect(await run(service.list())).toEqual([])
    expect(
      (await run(service.create(captureFixtureDocument(textReport())))).number
    ).toBe(1)
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

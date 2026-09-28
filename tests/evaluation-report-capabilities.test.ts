import { captureFixtureDocument } from "./helpers/report-document"
import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import {
  getTracerProjectId,
  registerTracerProjectId,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { semanticCatalog } from "../src/server/metrics/registry"
import { executeSemanticQuery } from "../src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import { semanticQuerySchema } from "../src/lib/semantic/query"
import { createReportService } from "../src/server/tracer/reports"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { reportCaptureSchema as reportInputSchema } from "../src/lib/tracer/reports"
import {
  presentDashboardResult,
  formatDisplayValue,
} from "../src/lib/tracer/dashboard-presentation"

const labels = {
  actualPath: ["datasetItem", "expectedOutput", "label"],
  predictedPath: ["trace", "output", "label"],
  positiveClass: true,
}
const range = () => [
  new Date(Date.now() - 86400000).toISOString(),
  new Date(Date.now() + 60000).toISOString(),
]
function query(
  model: string,
  measures: string[],
  extra: Record<string, unknown> = {}
) {
  return semanticQuerySchema.parse({
    measures: measures.map((m) => model + "." + m),
    timeDimensions: [{ dimension: model + ".createdAt", dateRange: range() }],
    total: true,
    ...extra,
  })
}
async function fixture(count = 6) {
  const db = await createTracerFixture()
  const facts = await seedEvalAttributionFacts(db, 2, count)
  const project = getTracerProjectId(db)
  await db.execute(
    sql`insert into datasets(id,project_id,name,created_at,updated_at) values('cases',${project},'Readable dataset',${facts.now.toISOString()},${facts.now.toISOString()})`
  )
  await db.execute(
    sql`insert into dataset_items(id,project_id,dataset_id,input_json,expected_output_json,created_at,updated_at) select 'case-'||i,${project},'cases','{}','{}',${facts.now.toISOString()},${facts.now.toISOString()} from generate_series(1,${count}) i`
  )
  await db.execute(sql`update eval_runs set dataset_id='cases'`)
  await db.execute(
    sql`update eval_run_targets set dataset_item_id='case-'||ordinal, snapshot_json=jsonb_build_object('datasetItem',jsonb_build_object('input',jsonb_build_object('case',ordinal),'expectedOutput',jsonb_build_object('label',ordinal<=3)),'trace',jsonb_build_object('output',jsonb_build_object('label',ordinal in (1,2,4)),'attributes',jsonb_build_object('cost.usd',0.01)))::text`
  )
  const version = String(
    (
      await db.execute(
        sql`select evaluator_version_id from eval_results limit 1`
      )
    ).rows[0].evaluator_version_id
  )
  const read = (q: unknown) =>
    executeSemanticQuery(q, {
      catalog: semanticCatalog,
      snapshotRunner: createSemanticSnapshotRunner(db),
      requestId: "report-test",
    })
  return { db, project, read, version }
}

test("classification counts targets once, exposes true denominators and preserves unknown labels", async () => {
  const { db, read } = await fixture()
  try {
    const q = query(
      "evalClassification",
      [
        "caseCount",
        "validCount",
        "missingCount",
        "tp",
        "fp",
        "fn",
        "tn",
        "precision",
        "recall",
        "f1",
        "accuracy",
        "predictedPositiveCount",
        "actualPositiveCount",
        "meanCostUsd",
      ],
      {
        classification: labels,
        filters: [
          {
            member: "evalClassification.runId",
            operator: "equals",
            values: ["run-1"],
          },
        ],
      }
    )
    let r = await read(q)
    const row = r.data[0]
    expect(row["evalClassification.caseCount"]).toBe(6) // two attribution memberships must not duplicate cases
    for (const [key, value] of Object.entries({
      tp: 2,
      fp: 1,
      fn: 1,
      tn: 2,
      precision: 2 / 3,
      recall: 2 / 3,
      f1: 2 / 3,
      accuracy: 2 / 3,
      predictedPositiveCount: 3,
      actualPositiveCount: 3,
      meanCostUsd: 0.01,
    }))
      expect(
        Math.abs(Number(row["evalClassification." + key]) - value) < 1e-9
      ).toBe(true)
    await db.execute(
      sql`update eval_run_targets set snapshot_json=jsonb_set(snapshot_json::jsonb,'{trace,output,label}','"true"')::text where id='target-1-1'`
    )
    r = await read(q)
    expect(r.data[0]["evalClassification.missingCount"]).toBe(1)
    expect(r.data[0]["evalClassification.precision"]).toBe(0.5)
    const negative = await read({
      ...q,
      classification: { ...labels, positiveClass: false },
    })
    expect(negative.data[0]["evalClassification.tp"]).toBe(2)
    const none = await read({
      ...q,
      filters: [
        {
          member: "evalClassification.caseId",
          operator: "equals",
          values: ["absent"],
        },
      ],
    })
    expect(none.data[0]["evalClassification.precision"]).toBeNull()
    expect(none.data[0]["evalClassification.caseCount"]).toBe(0)
    const presented = presentDashboardResult(r, {
      labels: { "evalClassification.precision": "Precision" },
      members: {
        "evalClassification.meanCostUsd": { unit: "USD", decimals: 3 },
      },
    })
    expect(
      formatDisplayValue(
        0.01,
        presented.annotation.measures["evalClassification.meanCostUsd"]
      )
    ).toBe("$0.010")
    expect(() =>
      presentDashboardResult(r, {
        members: { "evalClassification.precision": { unit: "seconds" } },
      })
    ).toThrow("incompatible")
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

test("paired comparisons exclude missing, duplicate, changed and unscored cases and suppress synthetic intervals", async () => {
  const { db, read, version } = await fixture(40)
  try {
    await db.execute(
      sql`update scores set value=case when eval_result_id like '%target-1-%' then 0.25 else 0.75 end`
    )
    const q = query(
      "evalComparison",
      [
        "matchedCount",
        "excludedCount",
        "improvedCount",
        "regressedCount",
        "unchangedCount",
        "meanDelta",
        "deltaCiLow",
        "deltaCiHigh",
      ],
      {
        comparison: {
          baselineRunIds: ["run-1"],
          candidateRunIds: ["run-2"],
          evaluatorVersionId: version,
        },
      }
    )
    let r = await read(q)
    expect(r.data[0]["evalComparison.matchedCount"]).toBe(40)
    expect(r.data[0]["evalComparison.improvedCount"]).toBe(40)
    expect(r.data[0]["evalComparison.deltaCiLow"]).toBe(0.5)
    expect(
      (
        await read({
          ...q,
          comparison: { ...q.comparison!, lowerIsBetter: true },
        })
      ).data[0]["evalComparison.regressedCount"]
    ).toBe(40)
    await db.execute(
      sql`update scores set value=0.25 where eval_result_id like '%target-2-%' and substring(eval_result_id from '[0-9]+$')::int > 20`
    )
    const varied = (await read(q)).data[0]
    const expectedLow = 0.25 - (1.96 * Math.sqrt(2.5 / 39)) / Math.sqrt(40)
    expect(
      Math.abs(Number(varied["evalComparison.deltaCiLow"]) - expectedLow) < 1e-9
    ).toBe(true)
    expect(varied["evalComparison.unchangedCount"]).toBe(20)
    expect(
      (
        await read({
          ...q,
          filters: [
            {
              member: "evalComparison.caseId",
              operator: "in",
              values: Array.from({ length: 29 }, (_, i) => "case-" + (i + 1)),
            },
          ],
        })
      ).data[0]["evalComparison.deltaCiLow"]
    ).toBeNull()
    await db.execute(
      sql`update eval_run_targets set snapshot_json=jsonb_set(snapshot_json::jsonb,'{trace,attributes,synthetic}','true')::text`
    )
    expect((await read(q)).data[0]["evalComparison.deltaCiLow"]).toBeNull()
    await db.execute(
      sql`update eval_run_targets set dataset_item_id='case-1' where id='target-2-2'`
    )
    await db.execute(
      sql`update eval_run_targets set snapshot_json=jsonb_set(snapshot_json::jsonb,'{datasetItem,input}','{"changed":true}')::text where id='target-2-3'`
    )
    await db.execute(
      sql`update scores set value=null where eval_result_id='result-target-2-4'`
    )
    r = await read({ ...q, dimensions: ["evalComparison.status"] })
    const count = (status: string) =>
      r.data.find((row) => row["evalComparison.status"] === status)?.[
        "evalComparison.excludedCount"
      ]
    expect(count("ambiguous")).toBe(1)
    expect(count("baselineOnly")).toBe(1)
    expect(count("changedSnapshot")).toBe(1)
    expect(count("missingScore")).toBe(1)
    expect(() =>
      semanticQuerySchema.parse({
        ...q,
        comparison: { ...q.comparison!, candidateRunIds: ["run-1"] },
      })
    ).toThrow("disjoint")
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)

test("capture resolves evidence, validates annotations and stays immutable and tenant scoped", async () => {
  const { db, read } = await fixture()
  const other = reopenTracerFixture(db)
  try {
    const q = query(
      "evalClassification",
      ["precision", "tp", "predictedPositiveCount"],
      { classification: labels, dimensions: ["evalClassification.runId"] }
    )
    const source = {
      widgetId: "quality",
      measure: "evalClassification.precision",
      dimensions: { "evalClassification.runId": "run-1" },
    }
    const input = reportInputSchema.parse({
      creationKey: crypto.randomUUID(),
      templateId: "custom",
      config: {
        schemaVersion: 1,
        name: "Evidence",
        description: "",
        widgets: [
          {
            id: "summary",
            type: "text",
            title: "Summary",
            width: 3,
            content:
              "Precision is {{evidence.precision}}; numerator {{evidence.tp}}.",
          },
          { id: "quality", type: "table", title: "Counts", width: 3, query: q },
        ],
      },
      bindings: [
        {
          id: "precision",
          textWidgetId: "summary",
          source,
          operation: "value",
          format: "percent",
          decimals: 1,
          expected: 2 / 3,
        },
        {
          id: "tp",
          textWidgetId: "summary",
          source: { ...source, measure: "evalClassification.tp" },
          operation: "value",
          decimals: 0,
        },
      ],
    })
    const service = createReportService(db)
    await assert.rejects(
      run(
        service.create(
          captureFixtureDocument({
            ...input,
            bindings: input.bindings!.map((b) => ({ ...b, expected: 99 })),
          })
        )
      ),
      new RegExp("expected value")
    )
    expect(await run(service.list())).toHaveLength(0)
    const report = await run(service.create(captureFixtureDocument(input)))
    expect(report.number).toBe(1)
    expect(report.snapshot.evidence?.values.map((v) => v.formatted)).toEqual([
      "66.7%",
      "2",
    ])
    expect(report.snapshot.evidence?.values).toHaveLength(2)
    await assert.rejects(
      run(
        service.create(
          captureFixtureDocument({
            ...input,
            creationKey: crypto.randomUUID(),
            bindings: input.bindings!.map((b) => ({
              ...b,
              source: { ...b.source, dimensions: {} },
            })),
          })
        )
      ),
      new RegExp("exactly one")
    )
    const chart = {
      id: "bar",
      type: "bar",
      width: 3,
      title: "Precision",
      query: { ...q, measures: ["evalClassification.precision"] },
    }
    const annotated = await run(
      service.create(
        captureFixtureDocument({
          creationKey: crypto.randomUUID(),
          templateId: "custom",
          config: {
            schemaVersion: 1,
            name: "Annotations",
            description: "",
            widgets: [chart],
          },
          highlights: [
            {
              widgetId: "bar",
              dimensions: { "evalClassification.runId": "run-1" },
              label: "Baseline",
            },
          ],
          references: [
            {
              widgetId: "bar",
              measure: "evalClassification.precision",
              value: 0.9,
              label: "Target",
            },
          ],
        })
      )
    )
    expect(annotated.snapshot.references?.[0].value).toBe(0.9)
    await assert.rejects(
      run(
        service.create(
          captureFixtureDocument({
            creationKey: crypto.randomUUID(),
            templateId: "custom",
            config: {
              schemaVersion: 1,
              name: "Bad",
              description: "",
              widgets: [chart],
            },
            highlights: [
              {
                widgetId: "bar",
                dimensions: { "evalClassification.runId": "absent" },
                label: "Missing",
              },
            ],
          })
        )
      ),
      new RegExp("does not match")
    )
    await db.execute(
      sql`update eval_run_targets set snapshot_json=jsonb_set(snapshot_json::jsonb,'{trace,output,label}','false')::text`
    )
    const zeroInput = {
      ...input,
      creationKey: crypto.randomUUID(),
      bindings: [
        {
          id: "ratio",
          textWidgetId: "summary",
          source: { ...source, measure: "evalClassification.tp" },
          baseline: {
            ...source,
            measure: "evalClassification.predictedPositiveCount",
          },
          operation: "ratio",
        },
      ],
      config: {
        ...input.config,
        widgets: input.config.widgets.map((w) =>
          w.type === "text" ? { ...w, content: "{{evidence.ratio}}" } : w
        ),
      },
    }
    await assert.rejects(
      run(service.create(captureFixtureDocument(zeroInput))),
      /divide by zero/
    )
    await db.execute(sql`update eval_run_targets set snapshot_json='{}'`)
    expect(await run(service.create(captureFixtureDocument(input)))).toEqual(
      report
    )
    expect(await run(service.get(1))).toEqual(report)
    registerTracerProjectId(other, "another-project")
    const isolated = await executeSemanticQuery(q, {
      catalog: semanticCatalog,
      snapshotRunner: createSemanticSnapshotRunner(other),
      requestId: "other",
    })
    expect(isolated.data).toEqual([])
    expect((await read(q)).data[0]["evalClassification.precision"]).toBeNull()
  } finally {
    await closeTracerDatabase(other)
    await closeTracerFixture(db)
  }
}, 30000)

test("invalid option combinations and empty measures fail validation without throwing", () => {
  expect(semanticQuerySchema.safeParse({ measures: [] }).success).toBe(false)
  expect(
    semanticQuerySchema.safeParse({
      measures: ["traces.count"],
      classification: labels,
    }).success
  ).toBe(false)
  expect(
    semanticQuerySchema.safeParse({
      measures: ["evalClassification.precision"],
    }).success
  ).toBe(false)
})

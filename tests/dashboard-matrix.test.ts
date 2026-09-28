import { expect, test } from "bun:test"
import {
  dashboardMatrix,
  matrixRowLabels,
  matrixRowSummaries,
  matrixScoreValue,
} from "../src/lib/tracer/dashboard-matrix"
import { newDashboardContentWidget } from "../src/lib/tracer/dashboards"
import { semanticCatalog } from "../src/server/metrics/registry"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"
import { dashboardDataWidgetSchema } from "../src/lib/tracer/dashboards"

test("matrix summaries query the original population with only row dimensions", () => {
  const widget = dashboardDataWidgetSchema.parse({
    id: "coverage",
    title: "Coverage",
    type: "matrix",
    width: 3,
    presentation: { showSummary: true },
    query: {
      measures: ["evalResults.meanScore"],
      dimensions: [
        "evalResults.datasetId",
        "evalResults.datasetItemId",
        "evalResults.evaluatorName",
      ],
      filters: [
        {
          member: "evalResults.groupVersion",
          operator: "equals",
          values: ["v4"],
        },
      ],
      timeDimensions: [
        {
          dimension: "evalResults.completedAt",
          dateRange: ["2026-09-22T00:00:00Z", "2026-09-27T00:00:00Z"],
        },
      ],
      order: [["evalResults.evaluatorName", "asc"]],
      limit: 20,
    },
  })
  const plan = dashboardQueryPlan([widget], {})
  const [cells, summary] = plan.batches[0]
  expect(summary.dimensions).toEqual(widget.query.dimensions.slice(0, -1))
  expect(summary.filters).toEqual(cells.filters)
  expect(summary.timeDimensions).toEqual(cells.timeDimensions)
  expect(summary.measures).toEqual(cells.measures)
  expect(summary.limit).toBe(5000)
  expect(summary.order).toEqual([])
  expect(plan.positions[0].cohorts[0].summary).toBe(1)
  expect(
    dashboardQueryPlan([{ ...widget, presentation: undefined }], {}).batches[0]
  ).toHaveLength(1)
  expect(
    dashboardDataWidgetSchema.safeParse({
      ...widget,
      query: {
        ...widget.query,
        having: [
          { member: "evalResults.meanScore", operator: "gt", values: [0.5] },
        ],
      },
    }).success
  ).toBe(false)
})

test("matrix row summaries join by full identity and preserve zero and missing scores", () => {
  const values = matrixRowSummaries(
    [
      { dataset: "A", item: "1", score: 0 },
      { dataset: "B", item: "1", score: 0.75 },
      { dataset: "B", item: "2", score: null },
    ],
    ["dataset", "item"],
    "score"
  )
  expect(values.get('["A","1"]')).toBe(0)
  expect(values.get('["B","1"]')).toBe(0.75)
  expect(values.get('["B","2"]')).toBeNull()
  expect(values.has('["A","2"]')).toBe(false)
  expect(() =>
    matrixRowSummaries(
      [
        { item: "1", score: 0 },
        { item: "1", score: 1 },
      ],
      ["item"],
      "score"
    )
  ).toThrow("duplicate rows")
})

test("matrix columns respect their explicit order when rows are sorted by score", () => {
  const rows = [
    { item: "failure", scorer: "Recall", score: 0 },
    { item: "failure", scorer: "Accuracy", score: 0 },
    { item: "success", scorer: "Precision", score: 1 },
  ]
  const matrix = dashboardMatrix(rows, ["item", "scorer"], "score", "asc")
  expect(matrix.columns.map(([, value]) => value)).toEqual([
    "Accuracy",
    "Precision",
    "Recall",
  ])
  expect(matrix.rows.map(([, row]) => row.item)).toEqual(["failure", "success"])
  expect(
    dashboardMatrix(rows, ["item", "scorer"], "score", "desc").columns.map(
      ([, value]) => value
    )
  ).toEqual(["Recall", "Precision", "Accuracy"])
})

test("evaluation matrices default to scores and preserve scorer and prompt identity", () => {
  const model = semanticCatalog
    .metadata()
    .models.find((model) => model.name === "evalResults")!
  const widget = newDashboardContentWidget("matrix", model)
  if (widget.type === "text") throw new Error("Expected matrix")
  expect(widget.query.measures).toEqual(["evalResults.meanScore"])
  expect(widget.query.dimensions.at(-1)).toBe("evalResults.datasetId")
  expect(widget.query.dimensions).toContain("evalResults.promptVersion")
  expect(widget.query.dimensions).toContain("evalResults.promptId")
  expect(widget.query.dimensions).toContain("evalResults.evaluatorVersion")
  expect(widget.query.dimensions).toContain("evalResults.evaluatorName")
})

test("compact labels move constants into shared context without changing cells", () => {
  const matrix = dashboardMatrix(
    [
      {
        operation: "Support",
        promptId: "one",
        version: "v1",
        scorer: "Accuracy",
        dataset: "A",
        score: 0,
      },
      {
        operation: "Support",
        promptId: "one",
        version: "v2",
        scorer: "Accuracy",
        dataset: "A",
        score: 0.9,
      },
    ],
    ["operation", "promptId", "version", "scorer", "dataset"],
    "score"
  )
  expect(matrixRowLabels(matrix)).toEqual({
    shared: ["operation", "promptId", "scorer"],
    varying: ["version"],
  })
  expect(matrix.rows).toHaveLength(2)
  expect([...matrix.cells.values()]).toEqual([0, 0.9])
})

test("opaque IDs are hidden only when visible labels still distinguish every row", () => {
  const rows = [
    { promptId: "one", version: "first v1", dataset: "A", score: 0.2 },
    { promptId: "two", version: "second v1", dataset: "A", score: 0.8 },
  ]
  expect(
    matrixRowLabels(
      dashboardMatrix(rows, ["promptId", "version", "dataset"], "score")
    ).varying
  ).toEqual(["version"])
  const duplicateNames = rows.map((row) => ({ ...row, version: "v1" }))
  expect(
    matrixRowLabels(
      dashboardMatrix(
        duplicateNames,
        ["promptId", "version", "dataset"],
        "score"
      )
    ).varying
  ).toEqual(["promptId"])
})

test("heatmap treats zero as a score and leaves absent, invalid and unrelated measures neutral", () => {
  expect(matrixScoreValue("evalResults.meanScore", 0)).toBe(0)
  expect(matrixScoreValue("evalResults.p95Score", 1)).toBe(1)
  expect(matrixScoreValue("evalResults.p50Score", 0.62)).toBe(0.62)
  for (const value of [null, undefined, NaN, -1, 2, "0.8"])
    expect(matrixScoreValue("evalResults.meanScore", value)).toBeNull()
  for (const measure of [
    "evalResults.executionCount",
    "evalResults.errorRate",
    "traces.costUsd",
  ])
    expect(matrixScoreValue(measure, 0.8)).toBeNull()
})

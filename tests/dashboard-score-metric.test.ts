import { expect, test } from "bun:test"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { metricDelta } from "@/src/lib/tracer/dashboard-metric-comparison"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  executeSemanticBatch,
  executeSemanticQuery,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import {
  traces,
  evaluators,
  evaluatorVersions,
  evalRuns,
  evalResults,
  scores,
} from "@/src/server/tracer/schema"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

test("named score tiles compare seven-day averages of the same definition and version", async () => {
  const db = await createTracerFixture()
  const createdAt = "2026-09-01T00:00:00Z"
  try {
    await db
      .insert(traces)
      .values(
        scopeRows(db, {
          id: "trace",
          name: "Extract brands",
          operation: "workflow",
          status: "completed",
          startedAt: createdAt,
        })
      )
    await db.insert(evaluators).values(
      scopeRows(db, [
        {
          id: "accuracy",
          name: "Brand extraction: accuracy",
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: "grounded",
          name: "Brand extraction: grounded brands",
          createdAt,
          updatedAt: createdAt,
        },
      ])
    )
    const versions = [
      { id: "accuracy-v3", evaluatorId: "accuracy", version: 3 },
      { id: "accuracy-v2", evaluatorId: "accuracy", version: 2 },
      { id: "grounded-v1", evaluatorId: "grounded", version: 1 },
    ]
    await db.insert(evaluatorVersions).values(
      scopeRows(
        db,
        versions.map((version) => ({
          ...version,
          language: "javascript",
          code: "return { score: 1 }",
          createdAt,
        }))
      )
    )
    await db
      .insert(evalRuns)
      .values(scopeRows(db, { id: "run", status: "completed", createdAt }))
    const ratings = [
      ["accuracy-v3", "2026-09-10T00:00:00Z", 0.4],
      ["accuracy-v3", "2026-09-16T23:59:59Z", 0.6],
      ["accuracy-v3", "2026-09-17T00:00:00Z", 0.8],
      ["accuracy-v3", "2026-09-23T23:59:59Z", 1],
      ["accuracy-v3", "2026-09-24T00:00:00Z", 0],
      ["accuracy-v2", "2026-09-18T00:00:00Z", 0],
      ["grounded-v1", "2026-09-18T00:00:00Z", 0],
    ] as const
    const results = ratings.map(([version, time, score], index) => ({
      id: `result-${index}`,
      runId: "run",
      traceId: "trace",
      evaluatorId: versions.find((item) => item.id === version)!.evaluatorId,
      evaluatorVersionId: version,
      status: "completed",
      score,
      createdAt: time,
    }))
    await db.insert(evalResults).values(scopeRows(db, results))
    await db.insert(scores).values(
      scopeRows(
        db,
        results.map((result) => ({
          id: `score-${result.id}`,
          traceId: result.traceId,
          evalResultId: result.id,
          evaluatorId: result.evaluatorId,
          name: "score",
          value: result.score,
          status: "ok",
          createdAt: result.createdAt,
        }))
      )
    )
    const context = {
      catalog: semanticCatalog,
      requestId: "score-metric",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    const widget = dashboardWidgetSchema.parse({
      id: "accuracy",
      title: "Brand extraction: accuracy",
      type: "metric",
      width: 1,
      query: {
        measures: ["scoreValues.meanValue"],
        filters: [
          {
            member: "scoreValues.definitionId",
            operator: "equals",
            values: ["evaluator:accuracy-v3:score"],
          },
        ],
        timeDimensions: [
          {
            dimension: "scoreValues.recordedAt",
            dateRange: ["2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z"],
          },
        ],
      },
    })
    const definitions = await executeSemanticQuery(
      {
        ...widget.query,
        filters: [],
        measures: ["scoreValues.count"],
        dimensions: [
          "scoreValues.definitionId",
          "scoreValues.name",
          "scoreValues.evaluatorName",
          "scoreValues.evaluatorVersion",
          "scoreValues.type",
          "scoreValues.scale",
          "scoreValues.origin",
        ],
      },
      context
    )
    expect(definitions.data).toHaveLength(3)
    expect(
      definitions.data.find(
        (row) =>
          row["scoreValues.definitionId"] === "evaluator:accuracy-v3:score"
      )
    ).toMatchObject({
      "scoreValues.name": "score",
      "scoreValues.evaluatorName": "Brand extraction: accuracy",
      "scoreValues.evaluatorVersion": "3",
      "scoreValues.type": "numeric",
      "scoreValues.scale": "0–1",
      "scoreValues.count": 2,
    })
    const plan = dashboardQueryPlan([widget], {})
    const [current, previous, history] = await executeSemanticBatch(
      { queries: plan.batches[0] },
      context
    )
    expect(current.data[0]["scoreValues.meanValue"]).toBe(0.9)
    expect(previous.data[0]["scoreValues.meanValue"]).toBe(0.5)
    expect(previous.query.timeDimensions[0].dateRange).toEqual([
      "2026-09-10T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z",
    ])
    expect(history.query.filters).toEqual(widget.query.filters)
    expect(
      metricDelta(
        current.data[0]["scoreValues.meanValue"],
        previous.data[0]["scoreValues.meanValue"],
        "increase"
      )
    ).toMatchObject({ available: true, relative: 0.8, tone: "positive" })
    const emptyPrior = await executeSemanticQuery(
      {
        ...previous.query,
        filters: [
          {
            member: "scoreValues.definitionId",
            operator: "equals",
            values: ["evaluator:accuracy-v2:score"],
          },
        ],
      },
      context
    )
    expect(emptyPrior.data[0]["scoreValues.meanValue"]).toBeNull()
  } finally {
    await closeTracerFixture(db)
  }
})

import { afterEach, describe, expect, test } from "bun:test"

import {
  parseSemanticQuery,
  type SemanticQueryInput,
} from "@/src/lib/semantic/query"
import { type SemanticModel } from "@/src/lib/semantic/model"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { evalRunsSemanticModel } from "@/src/server/metrics/eval-runs"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { scoresSemanticModel } from "@/src/server/metrics/scores"
import { tracesSemanticModel } from "@/src/server/metrics/traces"
import {
  createTracerDatabase,
  closeTracerDatabase,
  getTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  datasetItems,
  datasets,
  evaluatorVersions,
  evaluators,
  evalResults,
  evalRunTargets,
  evalRuns,
  scores,
  traces,
} from "@/src/server/tracer/schema"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const dayOne = "2026-01-02T00:00:00.000Z"
const dayTwo = "2026-01-03T00:00:00.000Z"
const dayThree = "2026-01-04T00:00:00.000Z"

const fixtures = new Set<IsolatedPostgres>()
const databases = new Set<TracerDatabase>()

afterEach(async () => {
  await Promise.all(
    [...databases].map((database) => closeTracerDatabase(database))
  )
  databases.clear()
  await Promise.all([...fixtures].map((fixture) => fixture.close()))
  fixtures.clear()
})

async function makeDatabase(): Promise<TracerDatabase> {
  const fixture = await createIsolatedPostgres()
  fixtures.add(fixture)
  await migrateIsolatedPostgres(fixture)
  await seedTestWorkspace(fixture)
  const database = createTracerDatabase(fixture.databaseUrl, {
    projectId: fixture.projectId,
    schema: fixture.schema,
  })
  databases.add(database)
  return database
}

function inProject<T extends Record<string, unknown>>(
  database: TracerDatabase,
  values: T
): T & { projectId: string }
function inProject<T extends Record<string, unknown>>(
  database: TracerDatabase,
  values: readonly T[]
): Array<T & { projectId: string }>
function inProject<T extends Record<string, unknown>>(
  database: TracerDatabase,
  values: T | readonly T[]
) {
  const withProject = (value: T) => ({
    ...value,
    projectId: getTracerProjectId(database),
  })
  return Array.isArray(values)
    ? values.map(withProject)
    : withProject(values as T)
}

async function execute(
  database: TracerDatabase,
  model: SemanticModel,
  query: SemanticQueryInput
) {
  const normalized = parseSemanticQuery(query)
  return createSemanticSnapshotRunner(database)((snapshot, asOf) =>
    model.execute(normalized, {
      asOf,
      requestId: "semantic-model-test",
      snapshot,
    })
  )
}

function timeDimension(dimension: string, from = dayOne, to = dayThree) {
  return [{ dateRange: [from, to] as [string, string], dimension }]
}

async function seedEvaluationReferences(
  database: TracerDatabase,
  options: {
    evaluatorId?: string
    traceIds: readonly string[]
  }
) {
  const evaluatorId = options.evaluatorId ?? "evaluator-1"
  await database.insert(traces).values(
    inProject(
      database,
      options.traceIds.map((id) => ({
        id,
        name: id,
        operation: "workflow.answer",
        startedAt: dayOne,
        status: "completed",
      }))
    )
  )
  await database.insert(evaluators).values(
    inProject(database, {
      activeVersionId: `${evaluatorId}-version-2`,
      createdAt: dayOne,
      id: evaluatorId,
      name: "Renamed evaluator",
      updatedAt: dayTwo,
    })
  )
  await database.insert(evaluatorVersions).values(
    inProject(database, [
      {
        code: "function evaluate() { return { score: 0 } }",
        createdAt: dayOne,
        evaluatorId,
        id: `${evaluatorId}-version-1`,
        language: "javascript",
        version: 1,
      },
      {
        code: "function evaluate() { return { score: 1 } }",
        createdAt: dayTwo,
        evaluatorId,
        id: `${evaluatorId}-version-2`,
        language: "javascript",
        version: 2,
      },
    ])
  )
}

describe("semantic models", () => {
  test("registers the explicit persisted-fact models", () => {
    expect(
      semanticCatalog.metadata().models.map((model) => model.name)
    ).toEqual([
      "agents",
      "evalQuality",
      "evalResults",
      "evalRuns",
      "logs",
      "scoreValues",
      "scores",
      "spans",
      "traces",
      "workflows",
    ])
    const traceId = semanticCatalog.getMember("scores.traceId")
    const evaluatorVersion = semanticCatalog.getMember(
      "scores.evaluatorVersion"
    )
    expect(traceId?.kind).toBe("dimension")
    expect(evaluatorVersion?.kind).toBe("dimension")
    if (traceId?.kind === "dimension") expect(traceId.groupable).toBe(false)
    if (evaluatorVersion?.kind === "dimension") {
      expect(evaluatorVersion.groupable).toBe(true)
    }
  })

  test("uses valid scores, explicit pass values, historical evaluator versions, and result-grain datasets", async () => {
    const database = await makeDatabase()
    await database.insert(datasets).values(
      inProject(database, [
        {
          createdAt: dayOne,
          id: "dataset-result",
          name: "Dataset reached through item",
          updatedAt: dayOne,
        },
        {
          createdAt: dayOne,
          id: "dataset-run",
          name: "Dataset attached to run",
          updatedAt: dayOne,
        },
      ])
    )
    await seedEvaluationReferences(database, {
      traceIds: ["trace-1", "trace-2", "trace-3", "trace-4", "trace-5"],
    })
    await database.insert(datasetItems).values(
      inProject(database, {
        datasetId: "dataset-result",
        id: "item-result",
        inputJson: "{}",
        metadataJson: "{}",
        createdAt: dayOne,
        updatedAt: dayOne,
      })
    )
    await database.insert(evalRuns).values(
      inProject(database, {
        createdAt: dayOne,
        datasetId: "dataset-run",
        id: "run-1",
        name: "Pinned historical run",
        status: "partial",
      })
    )
    await database.insert(evalResults).values(
      inProject(database, [
        {
          completedAt: "2026-01-02T00:10:00.000Z",
          createdAt: dayOne,
          datasetItemId: "item-result",
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-zero",
          metadataJson: "{}",
          passed: true,
          runId: "run-1",
          score: 0,
          status: "passed",
          traceId: "trace-1",
        },
        {
          completedAt: "2026-01-02T00:11:00.000Z",
          createdAt: dayOne,
          datasetItemId: "item-result",
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-one",
          metadataJson: "{}",
          passed: true,
          runId: "run-1",
          score: 1,
          status: "passed",
          traceId: "trace-1",
        },
        {
          completedAt: "2026-01-02T00:12:00.000Z",
          createdAt: dayOne,
          datasetItemId: "item-result",
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-failed-check",
          metadataJson: "{}",
          passed: false,
          runId: "run-1",
          score: 0.5,
          status: "failed",
          traceId: "trace-2",
        },
        {
          completedAt: "2026-01-02T00:13:00.000Z",
          createdAt: dayOne,
          datasetItemId: "item-result",
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-error",
          metadataJson: "{}",
          passed: null,
          runId: "run-1",
          score: null,
          status: "error",
          traceId: "trace-3",
        },
        {
          completedAt: "2026-01-02T00:14:00.000Z",
          createdAt: dayOne,
          datasetItemId: "item-result",
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-invalid-score",
          metadataJson: "{}",
          passed: null,
          runId: "run-1",
          score: 1.2,
          status: "completed",
          traceId: "trace-4",
        },
        {
          completedAt: null,
          createdAt: dayTwo,
          datasetItemId: null,
          evaluatorId: "evaluator-1",
          evaluatorVersionId: "evaluator-1-version-1",
          id: "result-created-at-fallback",
          metadataJson: "{}",
          passed: null,
          runId: "run-1",
          score: null,
          status: "completed",
          traceId: "trace-5",
        },
      ])
    )
    await database.insert(scores).values(
      inProject(database, [
        {
          createdAt: dayOne,
          evalResultId: "result-zero",
          evaluatorId: "evaluator-1",
          id: "score-zero",
          name: "score",
          status: "ok",
          traceId: "trace-1",
          value: 0,
        },
        {
          createdAt: dayOne,
          evalResultId: "result-one",
          evaluatorId: "evaluator-1",
          id: "score-one",
          name: "score",
          status: "ok",
          traceId: "trace-1",
          value: 1,
        },
        {
          createdAt: dayOne,
          evalResultId: "result-failed-check",
          evaluatorId: "evaluator-1",
          id: "score-failed-check",
          name: "score",
          status: "ok",
          traceId: "trace-2",
          value: 0.5,
        },
        {
          createdAt: dayOne,
          evalResultId: "result-error",
          evaluatorId: "evaluator-1",
          id: "score-error",
          name: "score",
          status: "error",
          traceId: "trace-3",
          value: null,
        },
        {
          createdAt: dayOne,
          evalResultId: "result-invalid-score",
          evaluatorId: "evaluator-1",
          id: "score-invalid",
          name: "score",
          status: "ok",
          traceId: "trace-4",
          value: 1.2,
        },
      ])
    )

    const total = await execute(database, scoresSemanticModel, {
      measures: [
        "scores.executionCount",
        "scores.scoredCount",
        "scores.meanScore",
        "scores.explicitPassCount",
        "scores.explicitFailCount",
        "scores.explicitPassRate",
        "scores.errorCount",
        "scores.failedCheckCount",
        "scores.uniqueTraceCount",
      ],
      timeDimensions: timeDimension("scores.completedAt"),
    })
    expect(total.rows).toEqual([
      {
        "scores.completedAt": null,
        "scores.errorCount": 1,
        "scores.executionCount": 6,
        "scores.explicitFailCount": 1,
        "scores.explicitPassCount": 2,
        "scores.explicitPassRate": 2 / 3,
        "scores.failedCheckCount": 1,
        "scores.meanScore": 0.5,
        "scores.scoredCount": 3,
        "scores.uniqueTraceCount": 5,
      },
    ])
    expect(total.quality.status).toBe("partial")

    const noValues = await execute(database, scoresSemanticModel, {
      filters: [
        {
          member: "scores.traceId",
          operator: "equals",
          values: ["trace-5"],
        },
      ],
      measures: [
        "scores.scoredCount",
        "scores.meanScore",
        "scores.explicitPassCount",
        "scores.explicitFailCount",
        "scores.explicitPassRate",
      ],
      timeDimensions: timeDimension("scores.completedAt"),
    })
    expect(noValues.rows).toEqual([
      {
        "scores.completedAt": null,
        "scores.explicitFailCount": 0,
        "scores.explicitPassCount": 0,
        "scores.explicitPassRate": null,
        "scores.meanScore": null,
        "scores.scoredCount": 0,
      },
    ])

    const dimensions = await execute(database, scoresSemanticModel, {
      dimensions: [
        "scores.datasetId",
        "scores.evaluatorVersion",
        "scores.evaluatorName",
        "scores.evalRunName",
      ],
      measures: ["scores.executionCount"],
      timeDimensions: timeDimension("scores.completedAt"),
    })
    expect(
      dimensions.rows.find(
        (row) => row["scores.datasetId"] === "dataset-result"
      )
    ).toMatchObject({
      "scores.evaluatorName": "Renamed evaluator",
      "scores.evaluatorVersion": 1,
      "scores.evalRunName": "Pinned historical run",
      "scores.executionCount": 5,
    })

    const createdAtFallback = await execute(database, scoresSemanticModel, {
      measures: ["scores.executionCount"],
      timeDimensions: timeDimension("scores.completedAt", dayTwo, dayThree),
    })
    expect(createdAtFallback.rows[0]?.["scores.executionCount"]).toBe(1)
  })

  test("unions selected target traces at the final eval-run group grain without result fanout", async () => {
    const database = await makeDatabase()
    await database.insert(datasets).values(
      inProject(database, {
        createdAt: dayOne,
        id: "dataset-1",
        name: "Eval data",
        updatedAt: dayOne,
      })
    )
    await seedEvaluationReferences(database, {
      evaluatorId: "evaluator-runs",
      traceIds: ["trace-shared"],
    })
    await database.insert(evalRuns).values(
      inProject(database, [
        {
          createdAt: dayOne,
          datasetId: "dataset-1",
          id: "run-a",
          name: "A",
          status: "completed",
        },
        {
          createdAt: dayOne,
          datasetId: "dataset-1",
          id: "run-b",
          name: "B",
          status: "completed",
        },
        {
          createdAt: dayOne,
          datasetId: "dataset-1",
          id: "run-c",
          name: "C",
          status: "failed",
        },
      ])
    )
    await database.insert(evalRunTargets).values(
      inProject(database, [
        {
          createdAt: dayOne,
          id: "target-a",
          ordinal: 0,
          runId: "run-a",
          traceId: "trace-shared",
        },
        {
          createdAt: dayOne,
          id: "target-b",
          ordinal: 0,
          runId: "run-b",
          traceId: "trace-shared",
        },
        {
          createdAt: dayOne,
          id: "target-c",
          ordinal: 0,
          runId: "run-c",
          traceId: "trace-shared",
        },
      ])
    )
    await database.insert(evalResults).values(
      inProject(database, [
        {
          createdAt: dayOne,
          evaluatorId: "evaluator-runs",
          evaluatorVersionId: "evaluator-runs-version-1",
          id: "result-a",
          metadataJson: "{}",
          runId: "run-a",
          status: "completed",
          traceId: "trace-shared",
        },
        {
          createdAt: dayOne,
          evaluatorId: "evaluator-runs",
          evaluatorVersionId: "evaluator-runs-version-1",
          id: "result-b",
          metadataJson: "{}",
          runId: "run-b",
          status: "completed",
          traceId: "trace-shared",
        },
        {
          createdAt: dayOne,
          evaluatorId: "evaluator-runs",
          evaluatorVersionId: "evaluator-runs-version-1",
          id: "result-c",
          metadataJson: "{}",
          runId: "run-c",
          status: "completed",
          traceId: "trace-shared",
        },
      ])
    )

    const total = await execute(database, evalRunsSemanticModel, {
      measures: [
        "evalRuns.count",
        "evalRuns.resultCount",
        "evalRuns.selectedTargetCount",
        "evalRuns.selectedUniqueTraceCount",
      ],
      timeDimensions: timeDimension("evalRuns.createdAt"),
    })
    expect(total.rows[0]).toMatchObject({
      "evalRuns.count": 3,
      "evalRuns.resultCount": 3,
      "evalRuns.selectedTargetCount": 3,
      "evalRuns.selectedUniqueTraceCount": 1,
    })

    const grouped = await execute(database, evalRunsSemanticModel, {
      dimensions: ["evalRuns.status"],
      measures: [
        "evalRuns.count",
        "evalRuns.selectedTargetCount",
        "evalRuns.selectedUniqueTraceCount",
      ],
      timeDimensions: timeDimension("evalRuns.createdAt"),
    })
    expect(grouped.rows).toEqual([
      {
        "evalRuns.count": 2,
        "evalRuns.createdAt": null,
        "evalRuns.selectedTargetCount": 2,
        "evalRuns.selectedUniqueTraceCount": 1,
        "evalRuns.status": "completed",
      },
      {
        "evalRuns.count": 1,
        "evalRuns.createdAt": null,
        "evalRuns.selectedTargetCount": 1,
        "evalRuns.selectedUniqueTraceCount": 1,
        "evalRuns.status": "failed",
      },
    ])
  })

  test("uses only persisted terminal trace durations and marks invalid samples partial", async () => {
    const database = await makeDatabase()
    await database.insert(traces).values(
      inProject(database, [
        {
          endedAt: "2026-01-02T00:00:00.100Z",
          id: "duration-100",
          name: "duration 100",
          operation: "duration.test",
          startedAt: dayOne,
          status: "completed",
        },
        {
          endedAt: "2026-01-02T00:00:00.300Z",
          id: "duration-300",
          name: "duration 300",
          operation: "duration.test",
          startedAt: dayOne,
          status: "errored",
        },
        {
          endedAt: "2026-01-01T23:59:59.000Z",
          id: "duration-invalid",
          name: "duration invalid",
          operation: "duration.test",
          startedAt: dayOne,
          status: "cancelled",
        },
        {
          id: "duration-running",
          name: "duration running",
          operation: "duration.test",
          startedAt: "2026-01-02T01:00:00.000+01:00",
          status: "running",
        },
      ])
    )

    const result = await execute(database, tracesSemanticModel, {
      measures: [
        "traces.count",
        "traces.completedCount",
        "traces.erroredCount",
        "traces.cancelledCount",
        "traces.runningCount",
        "traces.durationSampleCount",
        "traces.meanDurationMs",
        "traces.p95DurationMs",
      ],
      timeDimensions: timeDimension("traces.startedAt"),
    })
    expect(result.rows).toEqual([
      {
        "traces.cancelledCount": 1,
        "traces.completedCount": 1,
        "traces.count": 4,
        "traces.durationSampleCount": 2,
        "traces.erroredCount": 1,
        "traces.meanDurationMs": 200,
        "traces.p95DurationMs": 300,
        "traces.runningCount": 1,
        "traces.startedAt": null,
      },
    ])
    expect(result.quality.status).toBe("partial")
  })

  test("pushes offset-aware time candidates before the fact cap while retaining invalid timestamps for quality", async () => {
    const database = await makeDatabase()
    const oldFacts = Array.from({ length: 20_001 }, (_, index) => ({
      id: `old-${index}`,
      name: `old ${index}`,
      operation: "old.workflow",
      startedAt: "2025-01-01T00:00:00.000Z",
      status: "completed",
    }))
    for (let start = 0; start < oldFacts.length; start += 500) {
      await database
        .insert(traces)
        .values(inProject(database, oldFacts.slice(start, start + 500)))
    }
    await database.insert(traces).values(
      inProject(database, [
        {
          id: "offset-lower-bound",
          name: "included lower boundary",
          operation: "window.workflow",
          startedAt: "2026-01-02T01:00:00.000+01:00",
          status: "completed",
        },
        {
          id: "offset-upper-bound",
          name: "excluded upper boundary",
          operation: "window.workflow",
          startedAt: "2026-01-03T01:00:00.000+01:00",
          status: "completed",
        },
        {
          id: "invalid-timestamp",
          name: "invalid timestamp quality candidate",
          operation: "window.workflow",
          startedAt: dayOne,
          status: "completed",
        },
      ])
    )
    await (
      database as unknown as {
        $client: {
          query: (sql: string, values: readonly string[]) => Promise<unknown>
        }
      }
    ).$client.query(
      "UPDATE traces SET started_at = $1 WHERE project_id = $2 AND id = $3",
      ["not-an-instant", getTracerProjectId(database), "invalid-timestamp"]
    )

    const result = await execute(database, tracesSemanticModel, {
      measures: ["traces.count"],
      timeDimensions: timeDimension(
        "traces.startedAt",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z"
      ),
    })

    expect(result.rows).toEqual([
      {
        "traces.count": 1,
        "traces.startedAt": null,
      },
    ])
    expect(result.quality.status).toBe("partial")
    expect(result.quality.warnings.join(" ")).toContain("invalid startedAt")
  })
})

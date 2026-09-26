import { afterEach, describe, expect, test } from "bun:test"

import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  evaluatorVersions,
  evaluators,
  evalRunEvaluators,
  evalRuns,
  evalRunTargets,
  traces,
} from "@/src/server/tracer/schema"
import {
  recoverInterruptedEvalRuns,
  TracerService,
} from "@/src/server/tracer/service"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: { database: TracerDatabase; target: IsolatedPostgres }[] = []

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeService() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  return new TracerService(database)
}

async function makeDatabase() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  return { database, projectId: target.projectId }
}

async function expectRejected(promise: Promise<unknown>, message: string) {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toContain(message)
}

describe("tracer backend", () => {
  test("persists captured traces, runs a local evaluator, and projects a narrow saved view", async () => {
    const service = await makeService()
    const session = await runTracerEffect(
      service.createSession({
        attributes: { source: "test" },
        name: "Review session",
      })
    )
    const trace = await runTracerEffect(
      service.createTrace({
        input: { question: "What is the launch check?" },
        name: "launch-review",
        operation: "launch.review",
        output: {
          alternatives: [{ text: "First reviewed alternative" }],
          answer: { text: "Verify the source record before launch." },
        },
        sessionId: session.id,
        spans: [
          {
            id: "workflow-root",
            kind: "workflow",
            group: { type: "workflow", name: "Workflow" },
            name: "launch.review",
            status: "completed",
          },
          {
            id: "answer-agent",
            kind: "agent",
            group: { type: "agent", name: "Agent" },
            name: "answer",
            parentId: "workflow-root",
            status: "completed",
          },
        ],
        status: "completed",
      })
    )
    expect(trace.spans).toHaveLength(2)
    expect(trace.status).toBe("completed")

    const dataset = await runTracerEffect(
      service.createDataset({ name: "Launch review cases" })
    )
    const item = await runTracerEffect(
      service.createDatasetItem(dataset.id, {
        expectedOutput: { phrase: "source record" },
        input: { question: "What is the launch check?" },
        sourceTraceId: trace.id,
      })
    )
    const evaluator = await runTracerEffect(
      service.createEvaluator({
        code: `function evaluate({ trace, datasetItem }) {
  const phrase = datasetItem.expectedOutput.phrase
  const text = trace.output.answer.text
  return { score: text.includes(phrase) ? 0.8 : 0.2, reason: "Checked the selected output field" }
}`,
        language: "javascript",
        name: "Source phrase score",
      })
    )
    const run = await runTracerEffect(
      service.createEvalRun({
        metadata: {
          model: "test-model",
          config: { temperature: 0 },
          tags: ["regression"],
        },
        datasetId: dataset.id,
        datasetItemIds: [item.id],
        evaluatorIds: [evaluator.id],
      })
    )

    expect(run.metadata).toEqual({
      promptConfig: null,
      sourceRunId: null,
      datasetVersionId: null,
      parentRunId: null,
      useRecordedVersions: false,
      app: null,
      sourceApp: null,
      mode: "evidence",
      concurrency: 4,
      inputOverrides: {},
      model: "test-model",
      config: { temperature: 0 },
      tags: ["regression"],
    })
    const listed = await runTracerEffect(service.listEvalRuns())
    expect(listed.items.find((item) => item.id === run.id)?.metadata).toEqual(
      run.metadata
    )
    expect(
      (await runTracerEffect(service.getEvalRun(run.id))).metadata
    ).toEqual(run.metadata)
    expect(run.status).toBe("completed")
    expect(run.results).toHaveLength(1)
    expect(run.results[0]).toMatchObject({
      evaluatorVersion: 1,
      passed: null,
      score: 0.8,
      status: "completed",
    })

    const metrics = await runTracerEffect(
      service.querySemanticMetrics({
        measures: [
          "scores.meanScore",
          "scores.scoredCount",
          "scores.explicitPassRate",
        ],
        filters: [
          { member: "scores.evalRunId", operator: "equals", values: [run.id] },
        ],
        timeDimensions: [
          {
            dimension: "scores.completedAt",
            dateRange: [
              run.createdAt,
              new Date(Date.now() + 1000).toISOString(),
            ],
          },
        ],
      })
    )
    expect(metrics.data[0]).toMatchObject({
      "scores.meanScore": 0.8,
      "scores.scoredCount": 1,
    })
    expect(metrics.data[0]?.["scores.explicitPassRate"]).toBeNull()

    const view = await runTracerEffect(
      service.createSavedView({
        columns: [
          {
            format: "text",
            id: "answer",
            label: "Answer",
            selector: "trace.output.answer.text",
          },
          {
            format: "text",
            id: "alternative",
            label: "First alternative",
            selector: "trace.output.alternatives.0.text",
          },
          {
            format: "number",
            id: "score",
            label: "Score",
            selector: "result.score",
          },
          {
            format: "text",
            id: "reason",
            label: "Reason",
            selector: "result.reasoning",
          },
        ],
        name: "Narrow eval review",
        resource: "eval-results",
      })
    )
    const projection = await runTracerEffect(service.getSavedViewData(view.id))
    expect(projection.rows).toHaveLength(1)
    expect(projection.rows[0]?.values).toEqual({
      answer: "Verify the source record before launch.",
      alternative: "First reviewed alternative",
      reason: "Checked the selected output field",
      score: 0.8,
    })
    const refreshedTrace = await runTracerEffect(service.getTrace(trace.id))
    expect(refreshedTrace.scores[0]).toMatchObject({
      evaluatorName: "Source phrase score",
      evalResultId: run.results[0]?.id,
      evalRunId: run.id,
    })
  })

  test("records evaluator errors as errors instead of zero scores or failed passes", async () => {
    const service = await makeService()
    const trace = await runTracerEffect(
      service.createTrace({
        name: "error case",
        operation: "error.case",
        status: "completed",
      })
    )
    const evaluator = await runTracerEffect(
      service.createEvaluator({
        code: `function evaluate() { throw new Error("intentional evaluator failure") }`,
        language: "javascript",
        name: "Always errors",
      })
    )
    const run = await runTracerEffect(
      service.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [trace.id],
      })
    )
    expect(run.status).toBe("failed")
    expect(run.results[0]).toMatchObject({
      passed: null,
      score: null,
      status: "error",
    })
    expect(run.results[0]?.error).toContain("intentional evaluator failure")

    const metrics = await runTracerEffect(
      service.querySemanticMetrics({
        measures: [
          "scores.meanScore",
          "scores.scoredCount",
          "scores.explicitPassRate",
        ],
        filters: [
          { member: "scores.evalRunId", operator: "equals", values: [run.id] },
        ],
        timeDimensions: [
          {
            dimension: "scores.completedAt",
            dateRange: [
              run.createdAt,
              new Date(Date.now() + 1000).toISOString(),
            ],
          },
        ],
      })
    )
    expect(metrics.data[0]?.["scores.meanScore"]).toBeNull()
    expect(metrics.data[0]?.["scores.explicitPassRate"]).toBeNull()
  })

  test("rejects initial and reparented span cycles before they reach the trace graph", async () => {
    const service = await makeService()
    await expectRejected(
      runTracerEffect(
        service.createTrace({
          name: "invalid graph",
          operation: "graph.invalid",
          spans: [
            { id: "span-a", name: "A", parentId: "span-b" },
            { id: "span-b", name: "B", parentId: "span-a" },
          ],
        })
      ),
      "must not form a cycle"
    )

    const trace = await runTracerEffect(
      service.createTrace({
        name: "valid graph",
        operation: "graph.valid",
        spans: [
          { id: "root", name: "Root" },
          { id: "child", name: "Child", parentId: "root" },
        ],
      })
    )
    expect(trace.spans).toHaveLength(2)
    await expectRejected(
      runTracerEffect(service.patchSpan("root", { parentId: "child" })),
      "must not form a cycle"
    )
  })

  test("scopes a reusable eval-results view to the requested eval run", async () => {
    const service = await makeService()
    const firstTrace = await runTracerEffect(
      service.createTrace({
        name: "first",
        operation: "view.first",
        status: "completed",
      })
    )
    const secondTrace = await runTracerEffect(
      service.createTrace({
        name: "second",
        operation: "view.second",
        status: "completed",
      })
    )
    const evaluator = await runTracerEffect(
      service.createEvaluator({
        code: "function evaluate() { return { score: 1, passed: true } }",
        language: "javascript",
        name: "Always pass",
      })
    )
    const firstRun = await runTracerEffect(
      service.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [firstTrace.id],
      })
    )
    await runTracerEffect(
      service.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [secondTrace.id],
      })
    )
    const view = await runTracerEffect(
      service.createSavedView({
        columns: [
          { format: "text", id: "trace", label: "Trace", selector: "trace.id" },
        ],
        name: "Run-local review",
        resource: "eval-results",
      })
    )

    const scoped = await runTracerEffect(
      service.getSavedViewData(view.id, { runId: firstRun.id })
    )
    expect(scoped.rows).toHaveLength(1)
    expect(scoped.rows[0]?.values.trace).toBe(firstTrace.id)
  })

  test("keeps eval runs linked to the evaluator version that executed them", async () => {
    const service = await makeService()
    const trace = await runTracerEffect(
      service.createTrace({
        name: "versioned",
        operation: "versioned.eval",
        status: "completed",
      })
    )
    const evaluator = await runTracerEffect(
      service.createEvaluator({
        code: "function evaluate() { return { score: 1, passed: true } }",
        language: "javascript",
        name: "Versioned evaluator",
      })
    )
    const firstRun = await runTracerEffect(
      service.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [trace.id],
      })
    )
    const updated = await runTracerEffect(
      service.patchEvaluator(evaluator.id, {
        code: "function evaluate() { return { score: 0, passed: false } }",
      })
    )
    const secondRun = await runTracerEffect(
      service.createEvalRun({
        evaluatorIds: [evaluator.id],
        traceIds: [trace.id],
      })
    )

    expect(updated.activeVersion.version).toBe(2)
    expect(firstRun.results[0]).toMatchObject({
      evaluatorVersion: 1,
      passed: true,
      score: 1,
    })
    expect(secondRun.results[0]).toMatchObject({
      evaluatorVersion: 2,
      passed: false,
      score: 0,
    })
    const reloadedFirstRun = await runTracerEffect(
      service.getEvalRun(firstRun.id)
    )
    expect(reloadedFirstRun.results[0]?.evaluatorVersion).toBe(1)
  })

  test("keeps a durable eval target snapshot when startup recovers an interrupted run", async () => {
    const { database, projectId } = await makeDatabase()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await database.insert(traces).values({
      attributesJson: "{}",
      endedAt: null,
      id: "tr_interrupted",
      projectId,
      inputJson: null,
      name: "Interrupted target",
      operation: "interrupted.target",
      outputJson: null,
      sessionId: null,
      startedAt: timestamp,
      status: "running",
    })
    await database.insert(evaluators).values({
      activeVersionId: "evalv_interrupted",
      createdAt: timestamp,
      description: null,
      id: "evalr_interrupted",
      projectId,
      name: "Interrupted evaluator",
      updatedAt: timestamp,
    })
    await database.insert(evaluatorVersions).values({
      code: "function evaluate() { return { score: 1 } }",
      createdAt: timestamp,
      evaluatorId: "evalr_interrupted",
      id: "evalv_interrupted",
      projectId,
      language: "javascript",
      version: 1,
    })
    await database.insert(evalRuns).values({
      completedAt: null,
      createdAt: timestamp,
      datasetId: null,
      id: "erun_interrupted",
      projectId,
      name: "Interrupted run",
      status: "running",
    })
    await database.insert(evalRunEvaluators).values({
      evaluatorId: "evalr_interrupted",
      evaluatorVersionId: "evalv_interrupted",
      id: "ere_interrupted",
      projectId,
      runId: "erun_interrupted",
    })
    await database.insert(evalRunTargets).values({
      createdAt: timestamp,
      datasetItemId: null,
      id: "ertarget_interrupted",
      projectId,
      ordinal: 0,
      runId: "erun_interrupted",
      traceId: "tr_interrupted",
    })

    await recoverInterruptedEvalRuns(database)
    const service = new TracerService(database)
    const recovered = await runTracerEffect(
      service.getEvalRun("erun_interrupted")
    )
    expect(recovered).toMatchObject({
      resultCount: 0,
      status: "failed",
      targetCount: 1,
      traceCount: 1,
    })
  })
})

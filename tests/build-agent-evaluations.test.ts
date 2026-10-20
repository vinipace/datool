import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { createAgent } from "@/src/server/build/agents"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import {
  getTracerProjectId,
  registerTracerProjectId,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import {
  readDatasetItemLocation,
  writeDatasetItemLocation,
} from "@/src/lib/tracer/dataset-item-location"
import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { defaultScorer } from "@/src/lib/tracer/scorers"

// Owns the real dataset -> managed runtime -> eval -> row result contract.
// Guardrail cases exercise the applied agent without an external model dependency.
test("agent datasets and evaluations retain scope, frozen cases and result trace links", async () => {
  const database = await createTracerFixture()
  const foreignDatabase = registerTracerProjectId(
    reopenTracerFixture(database),
    "foreign-project"
  )
  const projectId = getTracerProjectId(database)
  const service = new TracerService(database)
  const foreign = new TracerService(foreignDatabase)
  const context = { database, projectId }
  try {
    const agent = await createAgent(context, {
      name: "Support",
      configuration: {
        channelAllowlist: ["web"],
        guardrails: { blockedTopics: ["refund"] },
      },
    })
    const other = await createAgent(context, { name: "Other" })
    const dataset = await run(
      service.createDataset({ name: "Support cases", agentId: agent.id })
    )
    const unrelated = await run(
      service.createDataset({ name: "Other cases", agentId: other.id })
    )
    expect(dataset.agentId).toBe(agent.id)
    expect(
      (
        await run(
          service.listDatasets({
            agentId: agent.id,
            limit: 1,
            includeTotal: true,
          })
        )
      ).items.map((d) => d.id)
    ).toEqual([dataset.id])
    expect(
      (await run(foreign.listDatasets({ agentId: agent.id }))).items
    ).toEqual([])
    await rejects(
      run(foreign.createDataset({ name: "Forbidden", agentId: agent.id }))
    )
    const saved = await run(
      service.patchDataset(dataset.id, { description: "Regression cases" })
    )
    expect(saved.agentId).toBe(agent.id)
    const item = await run(
      service.createDatasetItem(dataset.id, {
        input: "I need a refund",
        expectedOutput: "can’t help",
      })
    )
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Expected response",
        slug: "expected-response",
        type: "javascript",
        threshold: 1,
        code: "function evaluate({ trace, datasetItem }) { if (datasetItem.metadata?.error) throw new Error('Scorer unavailable'); return { score: trace.output.includes(datasetItem.expectedOutput) ? 1 : 0 }; }",
      })
    )
    await rejects(
      run(service.createEvalRun({ agentId: other.id, datasetId: dataset.id })),
      /linked/
    )
    await rejects(
      run(
        service.createEvalRun({ agentId: agent.id, datasetId: unrelated.id })
      ),
      /linked/
    )

    const wait = async (started: EvalRunDetail) => {
      let result = started
      const deadline = Date.now() + 10_000
      while (result.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        result = await run(service.getEvalRun(result.id))
      }
      return result
    }
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).evaluationSummary
    ).toMatchObject({ total: 1, notRun: 1, successRate: null })
    const first = await wait(
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [scorer.id],
        })
      )
    )
    expect(first.status).toBe("completed")
    expect(first.agentId).toBe(agent.id)
    expect(first.rows?.[0].trace.output).toContain("can’t help")
    expect(first.metadata.agentRevision).toBe(agent.appliedRevision)
    expect(
      first.groups?.some(
        (group) => group.type === "agent" && group.name === agent.name
      )
    ).toBe(true)
    expect(
      (await run(service.listEvalRuns({ agentId: other.id }))).items
    ).toEqual([])
    expect(
      (
        await run(
          service.listEvalRuns({ agentId: agent.id, includeTotal: true })
        )
      ).total
    ).toBe(1)

    const page = await run(
      service.listDatasetItems(dataset.id, {
        preview: true,
        includeResults: true,
      })
    )
    expect(page.items[0].latestEvaluation).toMatchObject({
      traceId: first.rows![0].trace.id,
      runId: first.id,
      targetId: first.rows![0].id,
      status: "completed",
      outcome: "passed",
      score: 1,
    })
    expect(page.evaluationSummary).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      successRate: 1,
    })
    await run(
      service.patchTrace(first.rows![0].trace.id, {
        output: "Changed after evaluation",
      })
    )
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation?.output
    ).toContain("can’t help")
    const target = await run(
      service.getEvalRunTarget(
        first.id,
        page.items[0].latestEvaluation!.targetId
      )
    )
    expect(target.scoringTrace?.output).toContain("can’t help")
    await rejects(run(foreign.getEvalRunTarget(first.id, target.id)))
    await run(service.patchDatasetItem(item.id, { input: "Edited question" }))
    const repeat = await wait(
      await run(service.createEvalRun({ parentRunId: first.id }))
    )
    expect(repeat.status).toBe("completed")
    expect(repeat.agentId).toBe(agent.id)
    expect(repeat.rows![0].trace.input).toBe("I need a refund")
    const latest = await run(
      service.listDatasetItems(dataset.id, { includeResults: true })
    )
    expect(latest.items[0].latestEvaluation?.runId).toBe(repeat.id)
    expect(latest.items[0].latestEvaluation?.traceId).toBe(
      repeat.rows![0].trace.id
    )
    expect(latest.evaluationSummary).toMatchObject({
      total: 1,
      passed: 1,
      successRate: 1,
    })

    // Aggregate all current cases, not only the visible/filter-matching page;
    // a scorer error or one failed verdict must not be averaged into a pass.
    await run(service.patchDatasetItem(item.id, { input: "I need a refund" }))
    for (const values of [
      { expectedOutput: "A refund has been sent", metadata: {} },
      { expectedOutput: "can’t help", metadata: { unscored: true } },
      { expectedOutput: "can’t help", metadata: { error: true } },
    ])
      await run(
        service.createDatasetItem(dataset.id, {
          input: "I need a refund",
          ...values,
        })
      )
    const secondScorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Additional verdict",
        slug: "additional-verdict",
        type: "javascript",
        code: "function evaluate({ datasetItem }) { return datasetItem.metadata?.unscored ? { score: 1 } : { score: 1, passed: true }; }",
      })
    )
    const mixed = await wait(
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [scorer.id, secondScorer.id],
        })
      )
    )
    expect(mixed.status).not.toBe("running")
    await run(
      service.createDatasetItem(dataset.id, { input: "Not tested yet" })
    )
    const filtered = await run(
      service.listDatasetItems(dataset.id, {
        includeResults: true,
        limit: 1,
        filter: `id = ${JSON.stringify(item.id)}`,
      })
    )
    expect(filtered.items).toHaveLength(1)
    expect(filtered.evaluationSummary).toEqual({
      total: 5,
      passed: 1,
      failed: 2,
      pending: 0,
      unscored: 1,
      cancelled: 0,
      notRun: 1,
      successRate: 1 / 3,
    })
    const outcomes = (
      await run(service.listDatasetItems(dataset.id, { includeResults: true }))
    ).items
    expect(
      outcomes.find((row) => row.expectedOutput === "A refund has been sent")
        ?.latestEvaluation
    ).toMatchObject({ outcome: "failed", score: 0.5 })
    expect(
      outcomes.find((row) => (row.metadata as { unscored?: boolean })?.unscored)
        ?.latestEvaluation
    ).toMatchObject({ outcome: "unscored", score: 1 })
    expect(
      (await run(service.listDatasets())).items.map((d) => d.id).sort()
    ).toEqual([dataset.id, unrelated.id].sort())
  } finally {
    await closeTracerDatabase(foreignDatabase)
    await closeTracerFixture(database)
  }
}, 60_000)

test("embedded dataset row links retain the agent Test route and dataset selection", () => {
  const path = "/p/demo/build/agents/support/test"
  const params = new URLSearchParams("datasetId=cases&section=test")
  const location = {
    itemId: "case 1",
    tab: "views" as const,
    viewId: "renderer",
  }
  const opened = writeDatasetItemLocation(path, params, location, true)
  expect(opened.pathname).toBe(path)
  expect(
    readDatasetItemLocation(path, new URLSearchParams(opened.search), true)
  ).toEqual(location)
  const closed = writeDatasetItemLocation(
    path,
    new URLSearchParams(opened.search),
    { ...location, itemId: null },
    true
  )
  expect(closed).toEqual({ pathname: path, search: params.toString() })
})

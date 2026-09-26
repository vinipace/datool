import { expect, test } from "bun:test"
import { rejects, strictEqual } from "node:assert/strict"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { parseCreateEvalRun } from "../src/server/tracer/validation"
import { effectiveEvalInput } from "../src/lib/tracer/eval-input-overrides"
import { pairEvalRows } from "../src/lib/tracer/eval-comparison"
import { serveWebhook } from "../src/server/apps/webhook"
import type { ResolvedApp } from "../src/server/apps/invoke"
import type { EvalRunDetail, JsonObject } from "../src/lib/tracer/contracts"
import { findAgentOperation } from "../src/server/mcp/operations"
import { defaultScorer } from "../src/lib/tracer/scorers"

const base = {
  mode: "connected" as const,
  appId: "extract",
  datasetId: "dataset",
  evaluatorIds: ["judge"],
}
test("input overrides are object-only, shallow, immutable and restricted to connected datasets", () => {
  const original = {
    model: "old",
    settings: { a: 1, b: 2 },
    list: [1, 2],
    optional: "old",
  }
  expect(
    effectiveEvalInput(original, {
      settings: { a: 3 },
      list: [4],
      optional: null,
    })
  ).toEqual({
    model: "old",
    settings: { a: 3 },
    list: [4],
    optional: null,
  })
  expect(original.settings).toEqual({ a: 1, b: 2 })
  expect(
    parseCreateEvalRun({ ...base, inputOverrides: {} }).inputOverrides
  ).toEqual({})
  for (const inputOverrides of [
    null,
    [],
    "model",
    1,
    { model: undefined },
    { model: Infinity },
  ])
    expect(() => parseCreateEvalRun({ ...base, inputOverrides })).toThrow()
  for (const change of [
    { mode: "traces" },
    { mode: undefined },
    { datasetId: undefined },
    { sourceRunId: "run" },
    { traceIds: ["trace"] },
  ])
    expect(() =>
      parseCreateEvalRun({ ...base, ...change, inputOverrides: {} })
    ).toThrow()
  for (const input of [null, [], "case", 1])
    expect(() => effectiveEvalInput(input, {})).toThrow("JSON object")
  expect(effectiveEvalInput("case")).toBe("case")
})

test("connected overrides execute effective inputs, preserve snapshots/references, pair deleted cases, and participate in idempotency", async () => {
  const database = await createTracerFixture()
  const received: JsonObject[] = []
  const webhook = await serveWebhook(async (request) => {
    const { input } = await request.json()
    received.push(input)
    return Response.json({ value: input.value, model: input.model })
  })
  const app: ResolvedApp = {
    connection: {
      id: "extract",
      name: "Extract",
      mode: "input",
      url: `http://127.0.0.1:${webhook.port}/call`,
    },
    definition: {
      id: "extract",
      name: "Extract",
      mode: "input",
      revision: 1,
      evaluatorIds: [],
      internalTracing: false,
      inputSchema: {
        type: "object",
        required: ["value", "model"],
        additionalProperties: false,
        properties: {
          value: { type: "number" },
          model: { type: "string" },
          settings: { type: "object" },
          list: { type: "array" },
          optional: {},
          promptSlug: { type: "string" },
          promptVersion: { type: "number" },
          discoveryPromptSlug: { type: "string" },
          discoveryPromptVersion: { type: "number" },
        },
      },
      outputSchema: { type: "object" },
    },
  }
  const service = new TracerService(database, { resolveApp: async () => app })
  async function finish(id: string) {
    const deadline = Date.now() + 15000
    let detail = await run(service.getEvalRun(id))
    while (detail.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      detail = await run(service.getEvalRun(id))
    }
    strictEqual(
      detail.status,
      "completed",
      JSON.stringify(detail.results.map(({ error, metadata }) => ({ error, metadata })))
    )
    return detail
  }
  const operation = findAgentOperation("start_eval_run")!
  const start = (input: Record<string, unknown>) =>
    run(operation.execute(service, input)) as Promise<EvalRunDetail>
  try {
    expect(operation.schema.shape.inputOverrides).toBeDefined()
    const ds = await run(service.createDataset({ name: "override cases" }))
    const items = []
    for (const value of [1, 2])
      items.push(
        await run(
          service.createDatasetItem(ds.id, {
            input: {
              value,
              model: "original",
              settings: { old: true },
              list: [1, 2],
              optional: "original",
            },
            expectedOutput: { value, secret: "reference only" },
            metadata: { secret: "metadata only" },
          })
        )
      )
    const originalDataset = await run(service.getDataset(ds.id))
    const snapshot = await run(service.agent.createSnapshot(ds.id))
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        type: "javascript",
        name: "Reference",
        slug: "reference",
        code: 'function evaluate({trace,datasetItem}) { return {score: trace.output.value === datasetItem.expectedOutput.value && datasetItem.input.model === "original" && datasetItem.metadata.secret === "metadata only" ? 1 : 0}; }',
      })
    )
    const inputOverrides = {
      model: "candidate-a",
      promptSlug: "extract",
      promptVersion: 2,
      discoveryPromptSlug: "discover",
      discoveryPromptVersion: 3,
      settings: { temperature: 0 },
      list: [9],
      optional: null,
    }
    const input = {
      ...base,
      datasetId: ds.id,
      evaluatorIds: [scorer.id],
      inputOverrides,
      requestKey: "overrides-a",
    }
    const started = await start(input)
    const result = await finish(started.id)
    expect(result.metadata.inputOverrides).toEqual(inputOverrides)
    expect(result.results.map((result) => result.score)).toEqual([1, 1])
    expect(
      received.toSorted((a, b) => Number(a.value) - Number(b.value))
    ).toEqual([1, 2].map((value) => ({ value, ...inputOverrides })))
    expect(await run(service.getDataset(ds.id))).toEqual(originalDataset)
    expect((await start(input)).id).toBe(result.id)
    await rejects(
      start({
        ...input,
        inputOverrides: { ...inputOverrides, model: "candidate-b" },
      }),
      /different evaluation inputs/
    )
    expect(received).toHaveLength(2)
    const snapshots = await database.execute(
      sql`select snapshot_json from eval_run_targets where run_id=${result.id}`
    )
    for (const row of snapshots.rows) {
      const frozen = JSON.parse(String(row.snapshot_json))
      expect(frozen.datasetItem.input.model).toBe("original")
      expect(frozen.datasetItem.expectedOutput.secret).toBe("reference only")
      expect(frozen.trace.input.model).toBe("candidate-a")
    }
    for (const item of items) await run(service.deleteDatasetItem(item.id))
    const a = await finish(
      (
        await start({
          ...input,
          datasetVersionId: snapshot.id,
          requestKey: "snapshot-a",
        })
      ).id
    )
    const b = await finish(
      (
        await start({
          ...input,
          datasetVersionId: snapshot.id,
          inputOverrides: { ...inputOverrides, model: "candidate-b" },
          requestKey: "snapshot-b",
        })
      ).id
    )
    const lightA = await run(
      service.getEvalRun(a.id, { includeEvidence: false })
    )
    const lightB = await run(
      service.getEvalRun(b.id, { includeEvidence: false })
    )
    expect(
      lightA.rows!.every(
        (row) => row.datasetItemId === null && !!row.datasetCaseId
      )
    ).toBe(true)
    expect(
      pairEvalRows(lightA.rows!, lightB.rows!).map((pair) => pair.matchedBy)
    ).toEqual(["dataset item", "dataset item"])
    const comparison = await run(service.compareEvalRuns(a.id, b.id, 0, false))
    expect(comparison.total).toBe(2)
    expect(comparison.pairs).toHaveLength(2)
    expect(comparison.pairs[0].matchedBy).toBe("dataset item")
    expect(comparison.pairs[0].left?.datasetCaseId).toBe(
      comparison.pairs[0].right?.datasetCaseId
    )
    const rescored = await finish(
      (
        await start({
          sourceRunId: a.id,
          evaluatorIds: [scorer.id],
          requestKey: "rescore-a",
        })
      ).id
    )
    expect(rescored.metadata.inputOverrides).toEqual(inputOverrides)
    expect(rescored.rows?.map((row) => row.trace.input)).toEqual(
      a.rows?.map((row) => row.trace.input)
    )
    expect(rescored.rows?.map((row) => row.expectedOutput)).toEqual(
      a.rows?.map((row) => row.expectedOutput)
    )
    expect(received).toHaveLength(6)
    await rejects(async () =>
      start({
        sourceRunId: a.id,
        evaluatorIds: [scorer.id],
        inputOverrides: {},
        requestKey: "bad-rescore",
      })
    )
    const count = await database.execute(sql`select count(*) as n from traces`)
    await rejects(
      start({
        ...input,
        datasetVersionId: snapshot.id,
        inputOverrides: { model: 123 },
        requestKey: "bad-schema",
      }),
      /effective input/
    )
    expect(
      (await database.execute(sql`select count(*) as n from traces`)).rows
    ).toEqual(count.rows)
    expect(received).toHaveLength(6)
    await rejects(
      run(
        service.createEvalRun({
          mode: "connected",
          appId: "extract",
          input: {},
          inputOverrides: {},
          evaluatorIds: [],
        })
      ),
      /inputOverrides/
    )
  } finally {
    webhook.stop()
    await closeTracerFixture(database)
  }
}, 60000)

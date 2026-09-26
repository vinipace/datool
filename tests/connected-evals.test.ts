import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { serveWebhook } from "../src/server/apps/webhook"
import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { executeScorer } from "../src/server/tracer/scorer-runtime"
import type { ResolvedApp } from "../src/server/apps/invoke"

async function fixture(app?: ResolvedApp) {
  const directory = await mkdtemp(join(tmpdir(), "datool-connected-"))
  const db = await createTracerFixture()
  const service = new TracerService(
    db,
    app ? { resolveApp: async () => app } : {}
  )
  return {
    service,
    close: async () => {
      await closeTracerFixture(db)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
const config = {
  ...defaultScorer,
  name: "Exact",
  slug: "exact",
  type: "javascript" as const,
  code: "function evaluate({ trace, datasetItem }) { return { score: trace.output.value === datasetItem.expectedOutput.value ? 1 : 0 }; }",
}

test("connected datasets create traces without SDK, isolate app failures, and freeze references and scorer versions", async () => {
  const server = await serveWebhook(async (request) => {
    const { input } = await request.json()
    if (input.value === 3) return new Response("failed", { status: 500 })
    return Response.json(input)
  })
  const app: ResolvedApp = {
    connection: {
      id: "plain",
      name: "Plain",
      mode: "input",
      url: `http://127.0.0.1:${server.port}/call`,
    },
    definition: {
      id: "plain",
      name: "Plain",
      mode: "input",
      revision: 1,
      evaluatorIds: [],
      internalTracing: false,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  }
  const f = await fixture(app)
  try {
    const scorer = await run(f.service.scorers.save(config))
    const ds = await run(f.service.createDataset({ name: "cases" }))
    const items = []
    for (const value of [1, 2, 3])
      items.push(
        await run(
          f.service.createDatasetItem(ds.id, {
            input: { value },
            expectedOutput: { value },
          })
        )
      )
    const started = await run(
      f.service.createEvalRun({
        mode: "connected",
        appId: "plain",
        datasetId: ds.id,
        evaluatorIds: [scorer.id],
        concurrency: 2,
      })
    )
    expect(started.status).toBe("running")
    await run(
      f.service.patchDatasetItem(items[0].id, {
        expectedOutput: { value: 999 },
      })
    )
    await run(
      f.service.scorers.save(
        {
          ...config,
          code: "function evaluate() { return { score: 0 }; }",
          expectedRevision: scorer.revision,
        },
        scorer.id
      )
    )
    let result = started
    const deadline = Date.now() + 10000
    while (result.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30))
      result = await run(f.service.getEvalRun(started.id))
    }
    expect(result.status).toBe("partial")
    expect(result.results).toHaveLength(3)
    expect(result.results.filter((r) => r.score === 1)).toHaveLength(2)
    expect(result.results.filter((r) => r.status === "error")).toHaveLength(1)
    const firstRow = result.rows!.find(
      (row) => (row.trace.input as { value: number }).value === 1
    )!
    expect(firstRow.expectedOutput).toEqual({ value: 1 })
    expect(firstRow.scoringTrace).toMatchObject({ scores: [{ score: 1, evalRunId: started.id, evaluatorId: scorer.id }] })
    expect(
      result.results.every((r) => r.evaluatorVersion === scorer.revision)
    ).toBe(true)
    expect(firstRow.trace.attributes["datool.trace.coverage"]).toBe(
      "invocation-only"
    )
    await run(
      f.service.patchTrace(firstRow.trace.id, { output: { value: "changed" } })
    )
    expect(
      (await run(f.service.getEvalRun(result.id))).rows?.find(
        (row) => row.trace.id === firstRow.trace.id
      )?.trace.output
    ).toEqual({ value: 1 })
    const rescored = await run(
      f.service.createEvalRun({
        sourceRunId: result.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(
      rescored.rows?.find((row) => row.trace.id === firstRow.trace.id)?.trace
        .output
    ).toEqual({ value: 1 })
    expect(
      rescored.rows?.find((row) => row.trace.id === firstRow.trace.id)
        ?.expectedOutput
    ).toEqual({ value: 1 })
    expect(rescored.results.filter((r) => r.score === 0)).toHaveLength(2)
    expect(rescored.rows?.find(row => row.trace.id === firstRow.trace.id)?.scoringTrace).toMatchObject({ scores: [{ score: 0, evalRunId: rescored.id, evaluatorId: scorer.id }] })
    expect((await run(f.service.getEvalRun(started.id))).rows?.find(row => row.trace.id === firstRow.trace.id)?.scoringTrace).toMatchObject({ scores: [{ score: 1, evalRunId: started.id }] })
  } finally {
    server.stop()
    await f.close()
  }
})

test("resource push/pull preserves IDs, retains omitted cases, and rejects stale bases", async () => {
  const f = await fixture()
  try {
    const document = {
      format: 1,
      kind: "dataset",
      key: "example/cases",
      description: "",
      items: [
        { key: "a", input: 1, expectedOutput: 1, metadata: {} },
        { key: "b", input: 2, expectedOutput: 2, metadata: {} },
      ],
    }
    const initial = await run(f.service.resources.push(document))
    expect((await run(f.service.resources.push(document))).revision).toBe(
      initial.revision
    )
    const ds = (await run(f.service.listDatasets())).items[0]
    const items = (await run(f.service.getDataset(ds.id))).items
    await run(f.service.patchDatasetItem(items[0].id, { expectedOutput: 7 }))
    expect(
      await run(
        f.service.resources.push(
          { ...document, description: "changed" },
          initial.revision
        )
      ).then(
        () => "unexpected",
        (e) => String(e)
      )
    ).toContain("Resource changed")
    const pulled = await run(
      f.service.resources.export("dataset", document.key)
    )
    await run(
      f.service.resources.push(
        { ...document, items: [document.items[0]] },
        pulled.revision
      )
    )
    expect(
      (await run(f.service.getDataset(ds.id))).items.map((i) => i.id).sort()
    ).toEqual(items.map((i) => i.id).sort())
    const preview = await run(
      f.service.resources.push(
        { ...document, description: "dry" },
        undefined,
        true
      )
    )
    expect(preview.conflict).toBe(true)
    expect((await run(f.service.getDataset(ds.id))).description).not.toBe("dry")
  } finally {
    await f.close()
  }
})

test("scorer catalog versions are immutable, legacy edits converge, and stale saves conflict", async () => {
  const f = await fixture()
  try {
    const scorer = await run(f.service.scorers.save(config))
    expect(
      (await run(f.service.scorers.save(config, scorer.id))).revision
    ).toBe(scorer.revision)
    expect((await run(f.service.listEvaluators())).items[0].id).toBe(scorer.id)
    await run(
      f.service.patchEvaluator(scorer.id, {
        code: "function evaluate() { return {score: 0}; }",
      })
    )
    const edited = await run(f.service.scorers.get(scorer.id))
    expect(edited.code).toContain("score: 0")
    expect(
      await run(
        f.service.scorers.save(
          { ...config, expectedRevision: scorer.revision },
          scorer.id
        )
      ).then(
        () => "unexpected",
        (e) => String(e)
      )
    ).toContain("Scorer changed")
    const exported = await run(
      f.service.resources.export("scorer", scorer.slug)
    )
    expect(exported.document.kind).toBe("scorer")
    expect(
      (await run(f.service.resources.push(exported.document))).revision
    ).toBe(exported.revision)
  } finally {
    await f.close()
  }
})

test("scorers evaluate available evidence even with legacy evidence requirements", async () => {
  const trace = {
    id: "trace",
    name: "test",
    operation: "app.invoke",
    input: null,
    output: null,
    sessionId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "completed" as const,
    spans: [],
    attributes: { "datool.trace.coverage": "invocation-only" },
  }
  const version = {
    id: "v",
    evaluatorId: "e",
    version: 1,
    createdAt: "",
    language: "javascript" as const,
    code: "function evaluate({ trace }) { return { score: trace.spans.length > 0 ? 1 : 0 }; }",
    config,
  }
  for (const requiredEvidence of [undefined, "invocation", "internal", "complete"]) {
    for (const allowSkip of [false, true]) {
      const legacyConfig = { ...config, requiredEvidence, allowSkip }
      const result = await executeScorer({ ...version, config: legacyConfig }, trace)
      expect(result.score).toBe(0)
      expect(result.error).toBeUndefined()
      expect(result.metadata?.skipped).toBeUndefined()
    }
  }
})

test("JavaScript scorers inspect real internal span evidence, not only output", async () => {
  const trace = {
    id: "trace",
    name: "test",
    operation: "app.invoke",
    input: null,
    output: null,
    sessionId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "completed" as const,
    spans: [
      {
        id: "tool",
        traceId: "trace",
        parentId: null,
        name: "lookup",
        kind: "tool" as const,
        status: "completed" as const,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        input: { query: "example" },
        output: { found: true },
        attributes: {},
        durationMs: 1,
      },
    ],
    attributes: { "datool.trace.coverage": "complete" },
  }
  const scorer = {
    ...config,
    code: 'function evaluate({ trace }) { return { score: trace.spans.some(s => s.kind === "tool" && s.output.found) ? 1 : 0 }; }',
  }
  const result = await executeScorer(
    {
      id: "v",
      evaluatorId: "e",
      version: 1,
      createdAt: "",
      language: "javascript",
      code: scorer.code,
      config: scorer,
    },
    trace
  )
  expect(result.score).toBe(1)
})

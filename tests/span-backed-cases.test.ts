import { rejects } from "node:assert/strict"
import { captureSpanEvidence } from "../src/server/tracer/span-evidence"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { TracerService } from "../src/server/tracer/service"
import { registerTracerProjectId } from "../src/server/tracer/db"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { findAgentOperation } from "../src/server/mcp/operations"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { promoteSpansSchema } from "../src/lib/tracer/span-promotion"
import { serveWebhook } from "../src/server/apps/webhook"
import type { ResolvedApp } from "../src/server/apps/invoke"

test("span promotion, snapshot, preview, saved evaluation and rescore preserve independent invocation identity", async () => {
  const db = await createTracerFixture()
  const received: unknown[] = []
  const webhook = await serveWebhook(async (request) => {
    const { input } = await request.json()
    received.push(input)
    return Response.json(input)
  })
  const app: ResolvedApp = {
    connection: {
      id: "mapped",
      name: "Mapped",
      mode: "input",
      url: `http://127.0.0.1:${webhook.port}/call`,
    },
    definition: {
      id: "mapped",
      name: "Mapped",
      mode: "input",
      revision: 1,
      evaluatorIds: [],
      internalTracing: false,
      inputSchema: {
        type: "object",
        required: ["response"],
        properties: { response: { type: "string" } },
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
    },
  }
  const service = new TracerService(db, { resolveApp: async () => app })
  const call = (name: string, value: unknown) =>
    run(findAgentOperation(name)!.execute(service, value))
  try {
    const trace = await run(
      service.createTrace({
        name: "Two production invocations",
        output: null,
        status: "completed",
      })
    )
    const timestamp = "2026-09-18T12:00:00.000Z"
    const a = await run(
      service.createSpan(trace.id, {
        name: "Extraction A",
        kind: "agent",
        input: { messages: [{ role: "user", content: "A" }] },
        output: { value: "A" },
        startedAt: timestamp,
        endedAt: timestamp,
        status: "completed",
        attributes: {
          "gen_ai.response.model": "extractor-v1",
          "prompt.version": "v7",
        },
      })
    )
    const child = await run(
      service.createSpan(trace.id, {
        name: "A model call",
        parentId: a.id,
        kind: "llm",
        input: "A",
        output: "A",
        status: "completed",
      })
    )
    const score = await run(
      service.createSpan(trace.id, {
        name: "Old scorer",
        parentId: a.id,
        kind: "score",
        output: "never evidence",
        status: "completed",
      })
    )
    const scorerChild = await run(
      service.createSpan(trace.id, {
        name: "Scorer model",
        parentId: score.id,
        kind: "llm",
        output: "never evidence",
        status: "completed",
      })
    )
    await rejects(
      run(service.getSpanEvidence(trace.id, scorerChild.id)),
      /Scorer execution/
    )
    const b = await run(
      service.createSpan(trace.id, {
        name: "Extraction B",
        kind: "agent",
        input: { messages: [{ role: "user", content: "B" }] },
        output: { value: "B" },
        startedAt: timestamp,
        endedAt: timestamp,
        status: "completed",
      })
    )
    const ds = await run(service.createDataset({ name: "span/cases" }))
    const selection = {
      datasetId: ds.id,
      spans: [
        { traceId: trace.id, spanId: a.id, mappedInput: { response: "A" } },
        { traceId: trace.id, spanId: b.id, mappedInput: { response: "B" } },
      ],
    }
    const preview = await run(
      service.agent.promoteSpans(promoteSpansSchema.parse(selection))
    )
    expect(preview.preview).toBe(true)
    expect((await run(service.getDataset(ds.id))).itemCount).toBe(0)
    expect(preview.cases[0].expectedOutput).toBeNull()
    expect(preview.cases[0].input).toEqual({ response: "A" })
    expect(preview.cases[0].observedOutput).toEqual({ value: "A" })
    expect(preview.cases[0].sourceSpanEvidence.input).toEqual(a.input)
    expect(
      preview.cases[0].sourceSpanEvidence.spans.map((s) => s.id).sort()
    ).toEqual([a.id, child.id].sort())
    expect(preview.cases[0].sourceSpanEvidence).toMatchObject({
      selectedSpanId: a.id,
      startedAt: timestamp,
      attributes: a.attributes,
    })
    const saved = await run(
      service.agent.promoteSpans(
        promoteSpansSchema.parse({
          ...selection,
          preview: false,
          expectedEvidenceHash: preview.evidenceHash,
        })
      )
    )
    expect(saved.created).toHaveLength(2)
    expect(new Set(saved.created).size).toBe(2)
    const snapshot = await run(service.agent.createSnapshot(ds.id))
    await run(service.patchSpan(a.id, { output: { value: "changed" } }))
    await run(
      service.patchDatasetItem(saved.created[0], {
        input: { response: "live edit" },
        expectedOutput: "new reference",
      })
    )
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Selected evidence",
        slug: "selected-evidence",
        type: "javascript",
        code: "function evaluate({trace}) { return {score: trace.output.value === trace.input.messages[0].content ? 1 : 0, passed: true, metadata: {selectedSpanId: trace.selectedSpanId, evidenceIds: trace.spans.map(s => s.id)}}; }",
      })
    )
    const tested = await run(
      service.agent.testScorer({
        traceId: trace.id,
        scorerId: scorer.id,
        datasetId: ds.id,
        datasetItemId: saved.created[0],
        datasetVersionId: snapshot.id,
      })
    )
    expect(tested).toMatchObject({
      persisted: false,
      evaluationRunCreated: false,
      executionSpanRetained: true,
      result: { score: 1 },
    })
    expect((await run(service.listEvalRuns())).items).toHaveLength(0)
    const first = await run(
      service.createEvalRun({
        name: "Frozen span evaluation",
        datasetId: ds.id,
        datasetVersionId: snapshot.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(first.status).toBe("completed")
    expect(first.results.map((r) => r.score)).toEqual([1, 1])
    expect(new Set(first.rows!.map((row) => row.id)).size).toBe(2)
    expect(
      new Set(first.results.map((r) => r.metadata.selectedSpanId))
    ).toEqual(new Set([a.id, b.id]))
    expect(first.rows![0].expectedOutput).toBeNull()
    await run(
      service.patchTrace(trace.id, {
        input: "changed root",
        output: "changed root",
      })
    )
    const rescore = await run(
      service.createEvalRun({
        sourceRunId: first.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(rescore.results.map((r) => r.score)).toEqual([1, 1])
    const connected = await run(
      service.createEvalRun({
        mode: "connected",
        appId: "mapped",
        datasetId: ds.id,
        datasetVersionId: snapshot.id,
        evaluatorIds: [scorer.id],
      })
    )
    for (let i = 0; i < 200; i++) {
      if ((await run(service.getEvalRun(connected.id))).status !== "running")
        break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(received.map((v) => JSON.stringify(v)).sort()).toEqual([
      '{"response":"A"}',
      '{"response":"B"}',
    ])
    expect(received).toHaveLength(2)
    const unmapped = await run(
      service.createDataset({ name: "Unmapped messages" })
    )
    await run(
      service.createDatasetItem(unmapped.id, {
        input: a.input,
        sourceTraceId: trace.id,
        sourceSpanId: a.id,
      })
    )
    await rejects(
      run(
        service.createEvalRun({
          mode: "connected",
          appId: "mapped",
          datasetId: unmapped.id,
          evaluatorIds: [scorer.id],
        })
      ),
      /input/i
    )
    // No promoted trace copies: only the original trace and two connected app executions.
    expect((await run(service.listTraces())).items).toHaveLength(3)
    await rejects(
      call("test_scorer", {
        traceId: trace.id,
        spanId: b.id,
        scorerId: scorer.id,
        datasetId: ds.id,
        datasetItemId: saved.created[0],
      }),
      /match/
    )
  } finally {
    webhook.stop()
    await closeTracerFixture(db)
  }
}, 60_000)

test("promotion authorization, mismatched sources, atomic rollback, bounds and explicit references", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  try {
    const ds = await run(service.createDataset({ name: "span/security" }))
    const trace = await run(
      service.createTrace({ name: "Root", status: "completed" })
    )
    const other = await run(
      service.createTrace({ name: "Other", status: "completed" })
    )
    const span = await run(
      service.createSpan(trace.id, {
        name: "Invocation",
        status: "completed",
        endedAt: new Date().toISOString(),
        input: "captured",
        output: "observed",
      })
    )
    const selection = {
      datasetId: ds.id,
      preview: false,
      spans: [{ traceId: trace.id, spanId: span.id }],
    }
    await rejects(
      run(
        service.agent.promoteSpans(
          promoteSpansSchema.parse({
            ...selection,
            spans: [...selection.spans, { traceId: other.id, spanId: span.id }],
          })
        )
      ),
      /another trace\/project/
    )
    expect((await run(service.getDataset(ds.id))).itemCount).toBe(0)
    await rejects(
      run(
        service.createDatasetItem(ds.id, { input: null, sourceSpanId: span.id })
      ),
      /requires sourceTraceId/
    )
    await rejects(
      run(
        service.agent.promoteSpans(
          promoteSpansSchema.parse({
            ...selection,
            expectedEvidenceHash: "stale",
          })
        )
      ),
      /changed after preview/
    )
    const copied = await run(
      service.agent.promoteSpans(
        promoteSpansSchema.parse({
          ...selection,
          spans: [{ ...selection.spans[0], copyObservedOutput: true }],
        })
      )
    )
    expect((await run(service.getDataset(ds.id))).items[0].expectedOutput).toBe(
      "observed"
    )
    expect(copied.created).toHaveLength(1)
    const huge = await run(
      service.createSpan(trace.id, {
        name: "Huge sibling",
        status: "completed",
        endedAt: new Date().toISOString(),
        input: "x".repeat(9 * 1024 * 1024),
      })
    )
    await rejects(
      run(service.getSpanEvidence(trace.id, huge.id)),
      /exceeds 1 MiB/
    )
    expect((await run(service.getSpanEvidence(trace.id, span.id))).output).toBe(
      "observed"
    )
    const foreign = registerTracerProjectId(
      Object.assign(Object.create(Object.getPrototypeOf(db)), db),
      "not-this-project"
    )
    await rejects(captureSpanEvidence(foreign, trace.id, span.id))
    await rejects(
      run(
        service.agent.promoteSpans(
          promoteSpansSchema.parse({
            ...selection,
            spans: [
              selection.spans[0],
              { traceId: trace.id, spanId: "missing" },
            ],
          })
        )
      )
    )
    const counts = await db.execute(
      sql`select count(*)::int as count from dataset_items`
    )
    expect(counts.rows[0].count).toBe(1)
  } finally {
    await closeTracerFixture(db)
  }
}, 30_000)

test("read-only readiness makes no provider calls; explicit probes and saved runs surface bounded sanitized infrastructure failures", async () => {
  const db = await createTracerFixture()
  let calls = 0
  const webhook = await serveWebhook(async () => {
    calls++
    return Response.json(
      {
        error: {
          code: "rate_limit_exceeded",
          message: "private provider explanation sk-secret",
        },
      },
      {
        status: 429,
        headers: { "retry-after": "0", "x-request-id": "req_fixture" },
      }
    )
  })
  const previous = {
    key: process.env.OPENAI_API_KEY,
    url: process.env.OPENAI_BASE_URL,
  }
  process.env.OPENAI_API_KEY = "synthetic-test-key"
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${webhook.port}/v1`
  try {
    const service = new TracerService(db)
    const trace = await run(
      service.createTrace({
        name: "Rate limit fixture",
        input: "input",
        output: "output",
        status: "completed",
      })
    )
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Mock judge",
        slug: "mock-judge",
        model: "fixture-model",
        threshold: 0.5,
      })
    )
    const configured = await run(
      service.agent.checkScorerRuntime({ scorerIds: [scorer.id] })
    )
    expect(configured.checks[0]).toMatchObject({
      configuration: "present",
      connectivity: "not_checked",
      execution: "not_checked",
    })
    expect(calls).toBe(0)
    const probe = await run(
      service.agent.probeScorerRuntime({
        scorerIds: [scorer.id],
        traceId: trace.id,
      })
    )
    expect(probe.checks[0]).toMatchObject({
      execution: "failed",
      result: {
        score: null,
        metadata: {
          runtimeDiagnostic: {
            category: "rate_limit",
            requestId: "req_fixture",
            httpStatus: 429,
          },
        },
      },
    })
    expect(calls).toBe(2)
    expect((await run(service.listEvalRuns())).items.length).toBe(0)
    const ds = await run(
      service.createDataset({ name: "Runtime failure cases" })
    )
    await run(
      service.agent.bulkDataset({
        datasetId: ds.id,
        create: Array.from({ length: 6 }, () => ({
          input: "input",
          sourceTraceId: trace.id,
        })),
      })
    )
    const saved = await run(
      service.createEvalRun({
        name: "Visible failed evaluation",
        datasetId: ds.id,
        evaluatorIds: [scorer.id],
      })
    )
    expect(saved.status).toBe("failed")
    expect(calls).toBe(4)
    expect(saved.results.length).toBe(6)
    expect(
      saved.results.every(
        (result) => result.status === "error" && result.score === null
      )
    ).toBe(true)
    expect(
      saved.results.filter((result) => result.metadata.runtimeCircuitOpen)
        .length
    ).toBe(5)
    expect(JSON.stringify(saved)).not.toContain("private provider explanation")
    expect(JSON.stringify(saved)).not.toContain("sk-secret")
    delete process.env.OPENAI_API_KEY
    expect(
      (await run(service.agent.checkScorerRuntime({ scorerIds: [scorer.id] })))
        .checks[0].configuration
    ).toBe("missing_or_invalid")
    const missing = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Missing project key",
        slug: "missing-project-key",
        provider: "typesafe-ai",
        modelType: "evaluation",
        model: "jev-latest",
      })
    )
    expect(
      (await run(service.agent.checkScorerRuntime({ scorerIds: [missing.id] })))
        .checks[0].configuration
    ).toBe("missing_or_invalid")
    expect(calls).toBe(4)
  } finally {
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous.key
    if (previous.url === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previous.url
    webhook.stop()
    await closeTracerFixture(db)
  }
}, 30_000)

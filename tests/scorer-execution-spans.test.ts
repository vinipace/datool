import { expect, test } from "bun:test"
import { defaultScorer } from "../src/lib/tracer/scorers"
import type { JsonObject, Span } from "../src/lib/tracer/contracts"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { scorerEvidence } from "../src/server/tracer/scorer-execution"
import { TracerService } from "../src/server/tracer/service"
import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { serveWebhook } from "../src/server/apps/webhook"

const config = {
  ...defaultScorer,
  type: "javascript" as const,
  name: "Recorded equality",
  slug: "recorded-equality",
  code: "function evaluate({ trace }) { return { score: trace.input === trace.output ? 1 : 0, metadata: { evidenceSpanIds: trace.spans.map(s => s.id) } }; }",
}
const executionSpans = (spans: Span[]) => spans.filter(span => span.attributes["datool.scorer.execution"] === true)

test("recorded scorer previews append distinct, complete success and error spans without scoring their own history", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const scorer = await run(service.scorers.save(config))
    const trace = await run(service.createTrace({ name: "Evidence", input: "same", output: "same", status: "completed" }))
    const original = await run(service.createSpan(trace.id, { name: "Answer", kind: "llm", status: "completed", input: "same", output: "same" }))
    const first = await run(service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id }))
    const second = await run(service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id }))
    const failed = await run(service.agent.testScorer({ traceId: trace.id, scorer: { ...config, code: 'function evaluate() { throw new Error("scorer failed deliberately") }' } }))
    const after = await run(service.getTraceArtifact(trace.id))
    const attempts = executionSpans(after.spans)
    expect(attempts).toHaveLength(3)
    expect(new Set(attempts.map(span => span.id)).size).toBe(3)
    expect(first.persisted).toBe(false) // Preview writes execution history, not an evaluation score.
    expect(after.scores).toHaveLength(0)
    expect(after.status).toBe(trace.status)
    expect(after.endedAt).toBe(trace.endedAt)
    expect(after.spans.find(span => span.id === original.id)).toEqual(original)
    for (const result of [first.result, second.result, failed.result]) {
      const span = attempts.find(span => span.id === result.metadata?.scorerSpanId)!
      expect(span.kind).toBe("score")
      expect(span.name).toBe(config.name)
      expect(span.endedAt).not.toBeNull()
      expect(span.durationMs).toBeGreaterThanOrEqual(0)
      const { metadata, ...output } = result
      expect(span.output).toEqual(output)
      expect(span.attributes).toMatchObject(metadata!)
      expect(span.input).toMatchObject({ trace: { id: trace.id, input: "same", output: "same", spans: [{ id: original.id }] }, scorer: { code: result.error ? 'function evaluate() { throw new Error("scorer failed deliberately") }' : config.code } })
      expect(((span.input as JsonObject).trace as JsonObject).spans).toHaveLength(1)
      expect(span.status).toBe(result.error ? "errored" : "completed")
    }
    expect(second.result.metadata?.evidenceSpanIds).toEqual([original.id])
    expect(attempts.find(span => span.id === failed.result.metadata?.scorerSpanId)?.attributes["error.message"]).toContain("scorer failed deliberately")
  } finally { await closeTracerFixture(db) }
})

test("eval snapshots show only their own execution spans, and reruns preserve the original evidence", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const scorer = await run(service.scorers.save(config))
    const trace = await run(service.createTrace({ name: "Evidence", input: "same", output: "same", status: "completed" }))
    const original = await run(service.createSpan(trace.id, { name: "Answer", kind: "llm", status: "completed" }))
    const first = await run(service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] }))
    const firstSpan = executionSpans(first.rows![0].scoringTrace!.spans)[0]
    expect(first.rows![0].scoringTrace).toMatchObject({ durationMs: trace.durationMs })
    expect(firstSpan).toBeDefined()
    expect(firstSpan.attributes).toMatchObject({ "eval.run_id": first.id, "eval.target_id": first.rows![0].id, "scorer.id": scorer.id })
    expect(first.results[0].metadata.scorerSpanId).toBe(firstSpan.id)
    await run(service.patchTrace(trace.id, { output: "changed later" }))
    const second = await run(service.createEvalRun({ evaluatorIds: [scorer.id], sourceRunId: first.id }))
    const secondSpan = executionSpans(second.rows![0].scoringTrace!.spans)[0]
    expect(secondSpan.id).not.toBe(firstSpan.id)
    expect(second.results[0].score).toBe(1)
    expect(second.results[0].metadata.evidenceSpanIds).toEqual([original.id])
    expect(secondSpan.input).toEqual(firstSpan.input)
    expect(executionSpans((await run(service.getEvalRun(first.id))).rows![0].scoringTrace!.spans).map(span => span.id)).toEqual([firstSpan.id])
    expect(executionSpans((await run(service.getTraceArtifact(trace.id))).spans)).toHaveLength(2)
    const fresh = await run(service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] }))
    expect(fresh.results[0].score).toBe(0)
    expect(fresh.results[0].metadata.evidenceSpanIds).toEqual([original.id])
    expect(executionSpans(fresh.rows![0].scoringTrace!.spans)).toHaveLength(1)
  } finally { await closeTracerFixture(db) }
})

test("failed eval attempts and skipped app failures remain inspectable with dataset context", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const scorer = await run(service.scorers.save({ ...config, code: 'function evaluate() { throw new Error("invalid evaluation") }' }))
    const trace = await run(service.createTrace({ name: "Failed case", input: "question", output: "answer", status: "completed" }))
    const dataset = await run(service.createDataset({ name: "Expected answers" }))
    const item = await run(service.createDatasetItem(dataset.id, { input: "question", expectedOutput: "answer", sourceTraceId: trace.id }))
    const failed = await run(service.createEvalRun({ evaluatorIds: [scorer.id], datasetId: dataset.id }))
    const span = executionSpans(failed.rows![0].scoringTrace!.spans)[0]
    expect(span.status).toBe("errored")
    expect(span.attributes["error.message"]).toContain("invalid evaluation")
    expect(span.input).toMatchObject({ datasetItem: { id: item.id, expectedOutput: "answer" } })
    expect(span.output).toMatchObject({ error: { kind: "runtime" } })
    await run(service.patchTrace(trace.id, { status: "errored", attributes: { "error.message": "upstream application failed" } }))
    const skipped = await run(service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] }))
    const skippedSpan = executionSpans(skipped.rows![0].scoringTrace!.spans)[0]
    expect(skippedSpan.attributes).toMatchObject({ "scorer.skipped": true, "error.message": "Scorer was not run because the source trace failed. upstream application failed" })
    expect(skippedSpan.status).toBe("errored")
    const live = await run(service.getTraceArtifact(trace.id))
    expect(executionSpans(live.spans)).toHaveLength(2)
    const evidence = scorerEvidence({ ...live, linkedTraces: [live] })
    expect(evidence.spans).toHaveLength(0)
    expect(evidence.linkedTraces![0].spans).toHaveLength(0)
  } finally { await closeTracerFixture(db) }
})

test("LLM requests expose a running span then retain rendered messages and HTTP failure context without credentials", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  const previousUrl = process.env.OPENAI_BASE_URL
  const previousKey = process.env.OPENAI_API_KEY
  let running: Span[] = []
  const trace = await run(service.createTrace({ name: "LLM evidence", input: "2 + 2", output: "4", status: "completed" }))
  const server = await serveWebhook(async () => {
    running = executionSpans((await run(service.getTraceArtifact(trace.id))).spans)
    return Response.json({ error: { message: "upstream private content must not be copied" } }, { status: 400 })
  })
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`
  process.env.OPENAI_API_KEY = "test-only-scorer-secret"
  try {
    const result = await run(service.agent.testScorer({ traceId: trace.id, scorer: {
      ...defaultScorer, name: "Judge", slug: "judge", provider: undefined, model: "test-model",
    } }))
    expect(running).toHaveLength(1)
    expect(running[0].status).toBe("running")
    expect(running[0].endedAt).toBeNull()
    const span = executionSpans((await run(service.getTraceArtifact(trace.id))).spans)[0]
    expect(span.id).toBe(running[0].id)
    expect(span.status).toBe("errored")
    expect(span.attributes).toMatchObject({ judgeHttpStatus: 400, judgeModel: "test-model", "error.message": "Provider rejected the request. Check model support for the requested scoring format. (HTTP 400)" })
    expect((span.input as JsonObject).judgeMessages).toEqual(result.result.metadata?.judgeMessages)
    const { metadata, ...output } = result.result
    expect(span.output).toEqual(output)
    expect(span.attributes).toMatchObject(metadata!)
    expect(JSON.stringify(span)).not.toContain("test-only-scorer-secret")
    expect(JSON.stringify(span)).not.toContain("upstream private content")
  } finally {
    if (previousUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    await server.stop()
    await closeTracerFixture(db)
  }
})

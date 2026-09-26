import { expect, test } from "bun:test"
import { parseScorerTraceIds, scorerTraceUrl } from "@/src/lib/tracer/scorer-traces"
import { parseCreateEvalRun } from "@/src/server/tracer/validation"
import { defaultScorer } from "@/src/lib/tracer/scorers"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { closeTracerDatabase } from "@/src/server/tracer/db"
import { createTracerFixture, closeTracerFixture, reopenTracerFixture } from "./helpers/tracer-fixture"

test("scorer links preserve and normalize optional trace selections", () => {
  expect(parseScorerTraceIds()).toEqual([])
  expect(parseScorerTraceIds([" a,b,a ", "b,c", ""])).toEqual(["a", "b", "c"])
  const url = new URL(scorerTraceUrl(["a/b", "c?d", "a/b"]), "http://localhost")
  expect(url.pathname).toBe("/scorers/new")
  expect(parseScorerTraceIds(url.searchParams.get("traceIds")!)).toEqual(["a/b", "c?d"])
  expect(scorerTraceUrl([])).toBe("/scorers/new")
})

test("background trace scoring survives a new reader and previews use full evidence without persisting scores", async () => {
  const db = await createTracerFixture()
  const readerDb = reopenTracerFixture(db)
  const service = new TracerService(db)
  const reader = new TracerService(readerDb)
  try {
    const traces = await Promise.all(["good", "bad"].map((output) => run(service.createTrace({
      name: output, output, status: "completed",
      spans: [{ name: "evidence", kind: "custom", status: "completed" }],
    }))))
    const config = {
      ...defaultScorer, type: "javascript" as const, name: "Evidence", slug: "evidence",
      code: 'function evaluate({trace}) { return {score: trace.spans.length > 0 && trace.output === "good" ? 1 : 0, reason: trace.output}; }',
    }
    const preview = await run(service.agent.testScorer({traceId: traces[0].id, scorer: config}))
    expect(preview.result.score).toBe(1)
    expect(preview.persisted).toBe(false)
    expect((await run(reader.listTraceScores(traces[0].id))).items).toHaveLength(0)
    const scorer = await run(service.scorers.save(config))
    const input = parseCreateEvalRun({mode: "traces", background: true, traceIds: traces.map(t => t.id), evaluatorIds: [scorer.id]})
    expect(input.background).toBe(true)
    const started = await run(service.createEvalRun(input))
    expect(started.status).toBe("running")
    let current = await run(reader.getEvalRun(started.id))
    const deadline = Date.now() + 10000
    while (current.status === "running" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
      current = await run(reader.getEvalRun(started.id))
    }
    expect(current.status).toBe("completed")
    expect(current.resultCount).toBe(2)
    const scores = await Promise.all(traces.map(t => run(reader.listTraceScores(t.id))))
    expect(scores.map(s => s.items[0].score)).toEqual([1, 0])
  } finally {
    await closeTracerDatabase(readerDb)
    await closeTracerFixture(db)
  }
}, 20000)

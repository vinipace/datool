import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultScorer, defaultPythonScorerCode, scorerInputSchema } from "../src/lib/tracer/scorers"
import { createScorerService } from "../src/server/tracer/scorers"
import { Effect } from "effect"

test("missing LLM model explains the selection requirement for both providers", () => {
  for (const provider of [undefined, "vercel-ai-gateway"] as const) {
    const parsed = scorerInputSchema.safeParse({ ...defaultScorer, name: "Test", slug: "test", provider })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toEqual(["Select a model for the LLM scorer."])
  }
})

test("scorers validate judge choices, model, code, slug and threshold", () => {
  const llm = {
    ...defaultScorer,
    name: "Quality",
    slug: "quality",
    model: "judge-model",
  }
  expect(scorerInputSchema.safeParse(llm).success).toBe(true)
  expect(scorerInputSchema.parse({ ...llm, chainOfThought: undefined }).chainOfThought).toBe(false)
  expect(scorerInputSchema.parse({ ...llm, chainOfThought: true }).chainOfThought).toBe(true)
  for (const requiredEvidence of ["invocation", "internal", "complete"]) {
    expect("requiredEvidence" in scorerInputSchema.parse({ ...llm, requiredEvidence })).toBe(false)
  }
  for (const patch of [
    { model: "" },
    { messages: [] },
    {
      choices: [
        { label: "a", score: 1 },
        { label: "b", score: 1 },
      ],
    },
    { threshold: 2 },
    { slug: "Bad Slug" },
    { type: "javascript", code: " " },
  ]) {
    expect(scorerInputSchema.safeParse({ ...llm, ...patch }).success).toBe(
      false
    )
  }
})

test("scorer CRUD persists all types and enforces unique slugs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datool-scorers-"))
  const database = await createTracerFixture()
  try {
    const service = createScorerService(database)
    const config = {
      ...defaultScorer,
      name: "Quality",
      slug: "quality",
      model: "judge-model",
      chainOfThought: true,
    }
    const created = await Effect.runPromise(service.save(config))
    expect((await Effect.runPromise(service.get(created.id))).chainOfThought).toBe(true)
    expect((await Effect.runPromise(service.list()))[0].messages).toEqual(
      config.messages
    )
    expect(
      await Effect.runPromise(service.save(config)).then(
        () => "unexpected success",
        (error) => String(error)
      )
    ).toContain("slug already exists")
    const updated = await Effect.runPromise(
      service.save({ ...config, type: "javascript" }, created.id)
    )
    expect(updated.revision).toBe(2)
    expect(updated.type).toBe("javascript")
    const python = await Effect.runPromise(service.save({ ...config, type: "python", code: defaultPythonScorerCode }, created.id))
    expect(python.type).toBe("python")
    expect(python.revision).toBe(3)
    expect((await Effect.runPromise(service.get(created.id))).code).toBe(defaultPythonScorerCode)
    const { TracerService } = await import("../src/server/tracer/service")
    const catalog = new TracerService(database)
    const saved = await Effect.runPromise(catalog.getEvaluator(created.id))
    expect(saved.activeVersion.language).toBe("python")
    await Effect.runPromise(service.remove(created.id))
    expect(await Effect.runPromise(service.list())).toEqual([])
    expect(
      await Effect.runPromise(service.save(config, created.id)).then(
        () => "unexpected success",
        (error) => String(error)
      )
    ).toContain("not found")
  } finally {
    await closeTracerFixture(database)
    await rm(dir, { recursive: true, force: true })
  }
})

test("test endpoint requires an explicit authorized project before processing samples", async () => {
  const { POST } = await import("../app/api/scorers/test/route")
  const foreign = await POST(
    new Request("http://localhost/api/scorers/test", {
      method: "POST",
      headers: { origin: "https://example.com" },
      body: "{}",
    })
  )
  expect(foreign.status).toBe(400)
  const invalid = await POST(
    new Request("http://localhost/api/scorers/test", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: JSON.stringify({ code: "function evaluate() {}", sample: {} }),
    })
  )
  expect(invalid.status).toBe(400)
})

test("saved Python scorers test three recorded traces through the shared service", async () => {
  const database = await createTracerFixture()
  try {
    const { TracerService } = await import("../src/server/tracer/service")
    const service = new TracerService(database)
    const config = { ...defaultScorer, type: "python" as const, name: "Python trace equality", slug: "python-trace-equality",
      code: 'def evaluate(trace, dataset_item=None):\n    matches = trace.get("input") == trace.get("output")\n    return {"score": matches, "passed": matches}',
    }
    const scorer = await Effect.runPromise(service.scorers.save(config))
    const scores = []
    for (const output of ["same", "same", "different"]) {
      const trace = await Effect.runPromise(service.createTrace({ name: "Python recorded case", input: "same", output, status: "completed" }))
      const result = await Effect.runPromise(service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id }))
      scores.push(result.result.score)
      expect(result.result.error).toBeUndefined()
    }
    expect(scores).toEqual([1, 1, 0])
  } finally {
    await closeTracerFixture(database)
  }
})

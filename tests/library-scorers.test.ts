import { expect, test } from "bun:test"
import {
  defaultScorer,
  scorerInputSchema,
  type ScorerInput,
} from "../src/lib/tracer/scorers"
import {
  defaultLibraryScorer,
  scorerLibraries,
  type LibraryEvaluatorId,
} from "../src/lib/tracer/scorer-libraries"
import {
  mapLibraryInputs,
  runLibraryScorer,
} from "../src/server/tracer/library-scorer"
import { executeScorer } from "../src/server/tracer/scorer-runtime"
import type {
  DatasetItemForEvaluation,
  TraceForEvaluation,
  JsonValue,
} from "../src/lib/tracer/contracts"

const trace: TraceForEvaluation = {
  id: "trace",
  name: "Case",
  operation: "test",
  status: "completed",
  input: "What is 2 + 2?",
  output: "4",
  attributes: {},
  spans: [],
  sessionId: null,
  startedAt: "2026-09-18T00:00:00Z",
  endedAt: null,
}
const item: DatasetItemForEvaluation = {
  id: "item",
  datasetId: "dataset",
  input: trace.input,
  expectedOutput: "4",
  sourceTraceId: null,
  metadata: {},
}
const config = (evaluator: LibraryEvaluatorId): ScorerInput => ({
  ...defaultScorer,
  type: "library",
  name: evaluator,
  slug: evaluator.toLowerCase(),
  code: "",
  library: defaultLibraryScorer(evaluator),
  ...(evaluator === "Factuality"
    ? {
        provider: "vercel-ai-gateway",
        model: "openai/gpt-4.1-mini",
        modelType: "language",
      }
    : {}),
  threshold: 0.8,
})
const completion = (choice = "C") =>
  Response.json({
    model: "gpt-4.1-mini-2025-04-14",
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "select_choice",
                arguments: JSON.stringify({
                  choice,
                  reasons: "Both answers agree.",
                }),
              },
            },
          ],
        },
      },
    ],
  })

test("curated library configurations reject unknown versions, arbitrary packages/options and unsafe mappings", () => {
  for (const entry of scorerLibraries[0].evaluators)
    expect(scorerInputSchema.safeParse(config(entry.id)).success).toBe(true)
  for (const patch of [
    { package: "arbitrary-npm" },
    { version: "latest" },
    { adapterVersion: 2 },
    { evaluator: "init" },
    { options: { client: "injected" } },
    {
      mappings: {
        output: "trace.constructor",
        expected: "datasetItem.expectedOutput",
      },
    },
    { mappings: { output: "" } },
  ]) {
    expect(
      scorerInputSchema.safeParse({
        ...config("ExactMatch"),
        library: { ...defaultLibraryScorer(), ...patch },
      }).success
    ).toBe(false)
  }
  expect(
    scorerInputSchema.safeParse({
      ...config("Factuality"),
      provider: "typesafe-ai",
    }).success
  ).toBe(false)
  expect(
    scorerInputSchema.safeParse({ ...config("Factuality"), model: "" }).success
  ).toBe(false)
})

test("field mappings preserve JSON types, arrays and explicit null, rejecting absent or oversized evidence", () => {
  const nested = config("ExactMatch")
  nested.library!.mappings = {
    output: "trace.output.answers.0",
    expected: "datasetItem.metadata.reference",
  }
  expect(
    mapLibraryInputs(
      nested,
      { ...trace, output: { answers: [false] } },
      { ...item, metadata: { reference: false } }
    )
  ).toEqual({ output: false, expected: false })
  expect(
    mapLibraryInputs(
      config("ExactMatch"),
      { ...trace, output: null },
      { ...item, expectedOutput: null }
    )
  ).toEqual({ output: null, expected: null })
  expect(() => mapLibraryInputs(config("ExactMatch"), trace)).toThrow(
    "Missing library input: expected"
  )
  expect(() =>
    mapLibraryInputs(config("Factuality"), { ...trace, output: {} }, item)
  ).toThrow("must be a string")
  expect(() => mapLibraryInputs(config("NumericDiff"), trace, item)).toThrow(
    "finite number"
  )
  expect(() =>
    mapLibraryInputs(
      config("ExactMatch"),
      { ...trace, output: "a".repeat(64_001) },
      item
    )
  ).toThrow("exceeds")
})

test("all five deterministic evaluators execute the real pinned package in a worker and apply thresholds", async () => {
  for (const [evaluator, output, expected] of [
    ["ExactMatch", { answer: 4 }, { answer: 4 }],
    ["Levenshtein", "answer", "answer"],
    ["NumericDiff", 42, 42],
    ["ValidJSON", '{"answer":4}', null],
    ["JSONDiff", { nested: [1, "yes"] }, { nested: [1, "yes"] }],
  ] as [LibraryEvaluatorId, JsonValue, JsonValue][]) {
    const current = config(evaluator)
    const result = await executeScorer(
      {
        id: "version",
        evaluatorId: "scorer",
        version: 1,
        language: "javascript",
        code: "",
        config: current,
        createdAt: trace.startedAt,
      },
      { ...trace, output: structuredClone(output) },
      { ...item, expectedOutput: structuredClone(expected) },
      "no-provider-project"
    )
    expect(result.error).toBeUndefined()
    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
    expect(result.metadata?.library).toEqual({
      package: "autoevals",
      version: "0.3.0",
      adapterVersion: 1,
      evaluator,
    })
  }
  expect(
    (
      await runLibraryScorer(config("ExactMatch"), trace, {
        ...item,
        expectedOutput: "5",
      })
    ).score
  ).toBe(0)
  const json = config("ValidJSON")
  json.library!.options = { schema: { type: "object", required: ["answer"] } }
  expect(
    (await runLibraryScorer(json, { ...trace, output: {} }, item)).score
  ).toBe(0)
  expect(
    (await runLibraryScorer(json, { ...trace, output: { answer: 4 } }, item))
      .score
  ).toBe(1)
}, 20_000)

test("Factuality uses isolated per-call credentials and captures the real library prompt, usage and reasoning", async () => {
  const results = await Promise.all(
    ["project-a-key", "project-b-key"].map((apiKey) =>
      runLibraryScorer(
        { ...config("Factuality"), chainOfThought: true },
        trace,
        item,
        {
          apiKey,
          provider: "vercel-ai-gateway",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          pricing: { autoRefresh: false },
          fetch: async (url, init) => {
            expect(String(url)).toBe(
              "https://ai-gateway.vercel.sh/v1/chat/completions"
            )
            expect(new Headers(init?.headers).get("authorization")).toBe(
              `Bearer ${apiKey}`
            )
            const body = JSON.parse(String(init?.body))
            expect(body.model).toBe("openai/gpt-4.1-mini")
            expect(body.messages[0].content).toContain("What is 2 + 2?")
            expect(body.tool_choice.function.name).toBe("select_choice")
            expect(body.max_completion_tokens).toBe(4096)
            return completion()
          },
        }
      )
    )
  )
  for (const result of results) {
    expect(result.error).toBeUndefined()
    expect(result.score).toBe(1)
    expect(result.reasoning).toBe("Both answers agree.")
    expect(result.metadata?.judgeAttempts).toBe(1)
    expect(
      (result.metadata?.judge as Record<string, unknown>)["usage.total_tokens"]
    ).toBe(110)
    expect(JSON.stringify(result)).not.toContain("project-a-key")
    expect(JSON.stringify(result)).not.toContain("project-b-key")
  }
}, 15_000)

test("library input failures do not contact providers and provider/format failures never become zero scores", async () => {
  let calls = 0
  const options = {
    apiKey: "sk-private-test",
    provider: "vercel-ai-gateway" as const,
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    pricing: { autoRefresh: false },
    fetch: async () => {
      calls++
      return completion()
    },
  }
  expect(
    (await runLibraryScorer(config("Factuality"), trace, null, options)).error
      ?.kind
  ).toBe("validation")
  expect(calls).toBe(0)
  for (const response of [
    new Response("sk-private-test", { status: 401 }),
    Response.json({ choices: [] }),
    completion("unknown"),
  ]) {
    const result = await runLibraryScorer(config("Factuality"), trace, item, {
      ...options,
      fetch: async () => response,
    })
    expect(result.score).toBeNull()
    expect(result.error).toBeDefined()
    expect(JSON.stringify(result)).not.toContain("sk-private-test")
  }
  const timed = await runLibraryScorer(config("Factuality"), trace, item, {
    ...options,
    timeoutMs: 500,
    fetch: async () => new Promise(() => {}),
  })
  expect(timed.error?.kind).toBe("timeout")
  const recovered = await runLibraryScorer(
    config("Factuality"),
    trace,
    item,
    options
  )
  expect(recovered.score).toBe(1)
}, 15_000)

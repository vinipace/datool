import { expect, test } from "bun:test"
import {
  runLlmScorer,
  renderJudgeMessages,
} from "../src/server/tracer/llm-scorer"
import { defaultScorer } from "../src/lib/tracer/scorers"
const trace = {
  id: "t",
  name: "test",
  operation: "app.invoke",
  input: { question: "hi" },
  output: { answer: "hello" },
  attributes: {},
  sessionId: null,
  status: "completed" as const,
  startedAt: "2026-09-09T00:00:00Z",
  endedAt: "2026-09-09T00:00:01Z",
  spans: [],
}
const config = {
  ...defaultScorer,
  name: "Quality",
  slug: "quality",
  model: "gpt-4.1-mini",
  threshold: 0.5,
}
const completion = (choice = "Pass") =>
  Response.json({
    model: "gpt-4.1-mini-2025-04-14",
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({ choice, reason: "Trace evidence matches" }),
        },
      },
    ],
  })
test("image scorers send actual vision content without putting base64 into text prompts", async () => {
  const url = `data:image/jpeg;base64,${"AAAA".repeat(20000)}`
  const result = await runLlmScorer({ ...config, imagePaths: ["output.image.url"], messages: [{ role: "user", content: "Grade the attached image for {{input.question}}" }] }, { ...trace, output: { image: { url } } }, null, {
    apiKey: "test", pricing: { autoRefresh: false }, fetch: async (_, options) => {
      const body = JSON.parse(String(options?.body))
      expect(body.messages[1].content).toBe('Grade the attached image for "hi"')
      expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url } }] })
      return completion()
    },
  })
  expect(result.score).toBe(1)
})
test("invalid, missing and oversized image evidence fails before contacting the judge", async () => {
  for (const url of [null, "javascript:alert(1)", "http://localhost/image", "data:image/svg+xml;base64,AAAA", `data:image/png;base64,${"A".repeat(2_000_001)}`]) {
    let contacted = false
    const result = await runLlmScorer({ ...config, messages: [{ role: "user", content: "Grade image" }], imagePaths: ["output.image.url"] }, { ...trace, output: { image: { url } } }, null, {
      apiKey: "test", fetch: async () => { contacted = true; return completion() },
    })
    expect(contacted).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.score).toBeNull()
  }
})
test("LLM scorer sends a strict schema, persists actual model/usage/cost, and applies threshold", async () => {
  const result = await runLlmScorer(config, trace, null, {
    apiKey: "test", pricing: { autoRefresh: false },
    fetch: async (_, options) => {
      const body = JSON.parse(String(options?.body))
      expect(body.response_format.json_schema.strict).toBe(true)
      expect(body.messages[0].content).toContain("Return only a JSON object")
      expect(body.messages[0].content).toContain(JSON.stringify(config.choices.map(choice => choice.label)))
      expect(body.messages[1].content).toContain("hello")
      return completion()
    },
  })
  expect(result.score).toBe(1)
  expect(result.passed).toBe(true)
  const judge = result.metadata?.judge as Record<string, unknown>
  expect(judge.model).toBe("gpt-4.1-mini-2025-04-14")
  expect(judge["usage.total_tokens"]).toBe(110)
  expect(typeof judge["cost.usd"]).toBe("number")
})
test("skips, unknown choices, provider errors, and malformed responses never become zero scores", async () => {
  const skip = await runLlmScorer({ ...config, allowSkip: true }, trace, null, {
    apiKey: "test", pricing: { autoRefresh: false },
    fetch: async () => completion("__datool_skip__"),
  })
  expect(skip.score).toBeNull()
  expect(skip.metadata?.skipped).toBe(true)
  for (const response of [
    completion("invented"),
    new Response("sk-private-secret", { status: 429 }),
    Response.json({ choices: [] }),
  ]) {
    const result = await runLlmScorer(config, trace, null, {
      apiKey: "test", pricing: { autoRefresh: false },
      fetch: async () => response,
    })
    expect(result.score).toBeNull()
    expect(result.error).toBeDefined()
    expect(JSON.stringify(result)).not.toContain("sk-private-secret")
  }
})
test("chain of thought requests rationale before the choice and preserves scoring and skips", async () => {
  for (const chainOfThought of [false, true]) {
    for (const choice of ["Pass", "__datool_skip__"]) {
      const result = await runLlmScorer({ ...config, chainOfThought, allowSkip: true }, trace, null, {
        apiKey: "test", pricing: { autoRefresh: false },
        fetch: async (_, options) => {
          const body = JSON.parse(String(options?.body))
          const schema = body.response_format.json_schema.schema
          const keys = chainOfThought ? ["reason", "choice"] : ["choice", "reason"]
          expect(Object.keys(schema.properties)).toEqual(keys)
          expect(schema.required).toEqual(keys)
          expect(schema.additionalProperties).toBe(false)
          expect(body.messages[0].content.includes("before choosing a score")).toBe(chainOfThought)
          return completion(choice)
        },
      })
      expect(result.reasoning).toBe("Trace evidence matches")
      expect(result.metadata?.judgeChainOfThought).toBe(chainOfThought)
      expect(result.score).toBe(choice === "Pass" ? 1 : null)
      expect(result.metadata?.skipped === true).toBe(choice !== "Pass")
    }
  }
})
test("trace selectors use own fields and reject missing or oversized evidence", () => {
  expect(
    renderJudgeMessages(
      {
        ...config,
        messages: [{ role: "user", content: "{{trace.output.answer}}" }],
      },
      trace
    )[0].content
  ).toBe('"hello"')
  for (const selector of ["trace.missing", "trace.__proto__"])
    expect(() =>
      renderJudgeMessages(
        { ...config, messages: [{ role: "user", content: `{{${selector}}}` }] },
        trace
      )
    ).toThrow()
  expect(() =>
    renderJudgeMessages(config, { ...trace, output: "x".repeat(65000) })
  ).toThrow()
})

test("Gateway free-credit restrictions are actionable without exposing upstream text", async () => {
  for (const restricted of [true, false]) {
    const result = await runLlmScorer(config, trace, null, {
      provider: "vercel-ai-gateway",
      apiKey: "test-secret",
      fetch: async () => Response.json({ error: {
        message: restricted
          ? "Free tier users do not have access to this model. test-secret"
          : "private provider diagnostic test-secret",
      } }, { status: 403 }),
    })
    expect(result.score).toBeNull()
    expect(result.error?.message).toContain(restricted ? "quota or credit restriction" : "denied access")
    expect(result.metadata?.judgeHttpStatus).toBe(403)
    expect(result.metadata?.judgeModel).toBe(config.model)
    expect(JSON.stringify(result)).not.toContain("test-secret")
    expect(JSON.stringify(result)).not.toContain("private provider diagnostic")
  }
})

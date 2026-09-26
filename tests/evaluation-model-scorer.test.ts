import { expect, test } from "bun:test"
import { runLlmScorer } from "../src/server/tracer/llm-scorer"
import { defaultScorer, scorerInputSchema } from "../src/lib/tracer/scorers"
import { GATEWAY_PROVIDER, TYPESAFE_PROVIDER } from "../src/lib/model-providers"

const config = {
  ...defaultScorer,
  name: "Native evaluation",
  slug: "native-evaluation",
  provider: GATEWAY_PROVIDER,
  model: "typesafe-ai/jev",
  modelType: "evaluation" as const,
  choices: [
    { label: "Não", score: 0 },
    { label: "Yes / refunded", score: 1 },
  ],
  messages: [
    {
      role: "user" as const,
      content: "Was a refund issued? Evidence: {{output}}",
    },
  ],
  threshold: 0.5,
}
const trace = {
  id: "test",
  name: "Synthetic support case",
  operation: "app.invoke",
  input: null,
  output: "The support agent issued a full refund.",
  attributes: {},
  sessionId: null,
  status: "completed" as const,
  startedAt: "2026-09-17T00:00:00Z",
  endedAt: "2026-09-17T00:00:01Z",
  spans: [],
}
const options = {
  provider: GATEWAY_PROVIDER,
  apiKey: "project-specific-key",
  pricing: { autoRefresh: false },
}

const directConfig = {
  ...config,
  provider: TYPESAFE_PROVIDER,
  model: "jev-latest",
}
const directResponse = () =>
  Response.json({
    model: "jev-2026-09-17",
    answers: {
      verdict: {
        type: "choice",
        choice: "choice_1",
        probabilities: { choice_0: 0.03, choice_1: 0.97 },
        confidence: 0.95,
      },
    },
    usage: { input_tokens: 50, output_tokens: 0 },
  })

test("TypeSafe uses its own key and direct endpoint, preserving the resolved model and native results", async () => {
  let calls = 0
  const result = await runLlmScorer(directConfig, trace, null, {
    ...options,
    provider: TYPESAFE_PROVIDER,
    apiKey: "project-typesafe-key",
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone")
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer project-typesafe-key"
      )
      expect(new Headers(init?.headers).get("ai-model-id")).toBeNull()
      expect(init?.redirect).toBe("error")
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe("jev-latest")
      expect(body.questions.verdict.criteria.choice_1).toBe("Yes / refunded")
      expect(body.state[0].content).toContain(trace.output)
      return directResponse()
    },
  })
  expect(calls).toBe(1)
  expect(result.error).toBeUndefined()
  expect(result.score).toBe(1)
  expect(result.passed).toBe(true)
  expect(result.metadata).toMatchObject({
    judgeProvider: TYPESAFE_PROVIDER,
    judgeConfidence: 0.95,
    judgeProbabilities: { Não: 0.03, "Yes / refunded": 0.97 },
    judge: {
      provider: TYPESAFE_PROVIDER,
      model: "jev-2026-09-17",
      "usage.total_tokens": 50,
    },
  })
})

test("TypeSafe errors are sanitized, never retried through Gateway, and never fall back to environment credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0
    const result = await runLlmScorer(directConfig, trace, null, {
      ...options,
      provider: TYPESAFE_PROVIDER,
      fetch: async () => {
        calls++
        return Response.json(
          { message: "private-key-provider-diagnostic" },
          { status }
        )
      },
    })
    expect(calls).toBe([429, 500].includes(status) ? 2 : 1)
    expect(result.score).toBeNull()
    expect(result.error?.message).toContain(`HTTP ${status}`)
    expect(result.metadata?.judgeHttpStatus).toBe(status)
    expect(JSON.stringify(result)).not.toContain(
      "private-key-provider-diagnostic"
    )
  }
  const previous = process.env.TYPESAFE_AI_API_KEY
  process.env.TYPESAFE_AI_API_KEY = "server-key-must-not-be-used"
  try {
    let calls = 0
    const result = await runLlmScorer(directConfig, trace, null, {
      ...options,
      provider: TYPESAFE_PROVIDER,
      apiKey: undefined,
      fetch: async () => {
        calls++
        return directResponse()
      },
    })
    expect(calls).toBe(0)
    expect(result.error?.message).toContain("Configure TypeSafe AI")
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_AI_API_KEY
    else process.env.TYPESAFE_AI_API_KEY = previous
  }
})

test("TypeSafe configurations validate native model IDs and persist their provider", () => {
  expect(scorerInputSchema.parse(directConfig).provider).toBe(TYPESAFE_PROVIDER)
  for (const change of [
    { modelType: "language" },
    { modelType: undefined },
    { model: "typesafe-ai/jev" },
    { chainOfThought: true },
    { imagePaths: ["output.image"] },
  ])
    expect(
      scorerInputSchema.safeParse({ ...directConfig, ...change }).success
    ).toBe(false)
})
const response = (
  choice = "choice_1",
  probabilities?: Record<string, number>
) =>
  Response.json({
    answers: {
      verdict: {
        type: "choice",
        choice,
        ...(probabilities ? { probabilities } : {}),
      },
    },
    usage: { inputTokens: 42, outputTokens: 0 },
    providerMetadata: {
      typesafe: { confidence: { verdict: 0.93 }, private: "do not copy" },
    },
  })

test("native evaluation uses the SDK Gateway protocol and preserves choice scores, probabilities and usage", async () => {
  let calls = 0
  const result = await runLlmScorer(config, trace, null, {
    ...options,
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe(
        "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
      )
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer project-specific-key")
      expect(headers.get("ai-model-id")).toBe("typesafe-ai/jev")
      expect(headers.get("ai-evaluation-model-specification-version")).toBe("4")
      expect(init?.redirect).toBe("error")
      const body = JSON.parse(String(init?.body))
      expect(body.questions.verdict).toMatchObject({
        type: "choice",
        criteria: { choice_0: "Não", choice_1: "Yes / refunded" },
      })
      expect(body.state).toEqual([
        {
          role: "user",
          content: `Was a refund issued? Evidence: "${trace.output}"`,
        },
      ])
      expect(body.messages).toBeUndefined()
      return response("choice_1", { choice_0: 0.04, choice_1: 0.96 })
    },
  })
  expect(calls).toBe(1)
  expect(result.error).toBeUndefined()
  expect(result.score).toBe(1)
  expect(result.passed).toBe(true)
  expect(result.reasoning).toBeUndefined()
  expect(result.metadata).toMatchObject({
    judgeModelType: "evaluation",
    judgeChoice: "Yes / refunded",
    judgeConfidence: 0.93,
    judgeProbabilities: { Não: 0.04, "Yes / refunded": 0.96 },
    judge: { model: "typesafe-ai/jev", "usage.total_tokens": 42 },
  })
  expect(JSON.stringify(result)).not.toContain("project-specific-key")
  expect(JSON.stringify(result)).not.toContain("do not copy")
})

test("native evaluation preserves skips, failed thresholds, and missing usage", async () => {
  const skip = await runLlmScorer({ ...config, allowSkip: true }, trace, null, {
    ...options,
    fetch: async (_, init) => {
      expect(
        JSON.parse(String(init?.body)).questions.verdict.criteria.skip
      ).toContain("Insufficient evidence")
      return response("skip", { choice_0: 0.1, choice_1: 0.1, skip: 0.8 })
    },
  })
  expect(skip.score).toBeNull()
  expect(skip.passed).toBeNull()
  expect(skip.metadata?.skipped).toBe(true)
  expect(skip.metadata?.judgeSkipProbability).toBe(0.8)
  const fail = await runLlmScorer(config, trace, null, {
    ...options,
    fetch: async () => response("choice_0"),
  })
  expect(fail.score).toBe(0)
  expect(fail.passed).toBe(false)
  const missing = await runLlmScorer(
    { ...config, threshold: null },
    trace,
    null,
    {
      ...options,
      fetch: async () =>
        Response.json({
          answers: { verdict: { type: "choice", choice: "choice_1" } },
        }),
    }
  )
  expect(missing.score).toBe(1)
  expect(missing.passed).toBeNull()
  expect(
    (missing.metadata?.judge as Record<string, unknown>)["usage.total_tokens"]
  ).toBeUndefined()
})

test("native evaluation rejects malformed answers and never exposes SDK error payloads", async () => {
  for (const reply of [
    () => response("invented"),
    () => response("choice_0", { choice_0: 0.1, choice_1: 0.9 }),
    () => Response.json({ answers: {} }),
    () =>
      Response.json(
        { error: { message: "project-specific-key private provider detail" } },
        { status: 403 }
      ),
    () =>
      Response.json(
        { error: { message: "project-specific-key private provider detail" } },
        { status: 429 }
      ),
  ]) {
    let calls = 0
    const result = await runLlmScorer(config, trace, null, {
      ...options,
      fetch: async () => {
        calls++
        return reply()
      },
    })
    expect(calls).toBe(reply().status === 429 ? 2 : 1)
    expect(result.error).toBeDefined()
    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(JSON.stringify(result)).not.toContain("project-specific-key")
    expect(JSON.stringify(result)).not.toContain("private provider detail")
  }
})

test("native evaluation honors timeouts", async () => {
  const result = await runLlmScorer(config, trace, null, {
    ...options,
    timeoutMs: 10,
    fetch: async (_, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        )
      }),
  })
  expect(result.error?.kind).toBe("timeout")
  expect(result.score).toBeNull()
})

test("evaluation configuration survives parsing and rejects unsupported settings before execution", async () => {
  expect(scorerInputSchema.parse(config).modelType).toBe("evaluation")
  for (const change of [
    { provider: undefined },
    { chainOfThought: true },
    { imagePaths: ["output.image"] },
  ]) {
    expect(scorerInputSchema.safeParse({ ...config, ...change }).success).toBe(
      false
    )
    let calls = 0
    const result = await runLlmScorer({ ...config, ...change }, trace, null, {
      ...options,
      ...(change.provider === undefined && "provider" in change
        ? { provider: undefined }
        : {}),
      fetch: async () => {
        calls++
        return response()
      },
    })
    expect(calls).toBe(0)
    expect(result.score).toBeNull()
    expect(result.error).toBeDefined()
  }
})

import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  projectModels,
  modelOptionValue,
} from "../src/lib/model-providers"
import { gatewayModels } from "../.storybook/scenarios/model-providers"
import { defaultScorer, scorerInputSchema } from "../src/lib/tracer/scorers"
import {
  defaultPrompt,
  promptConfigSchema,
  promptDraftSchema,
} from "../src/lib/tracer/prompts"
import { runLlmScorer } from "../src/server/tracer/llm-scorer"
import { previewPrompt } from "../src/server/tracer/prompt-preview"

const config = {
  ...defaultScorer,
  name: "Judge",
  slug: "judge",
  provider: OPENAI_PROVIDER,
  model: "gpt-4.1-mini",
}
const trace = {
  id: "t",
  name: "test",
  operation: "app.invoke",
  input: "hi",
  output: "hello",
  attributes: {},
  sessionId: null,
  status: "completed" as const,
  startedAt: "2026-09-18T00:00:00Z",
  endedAt: "2026-09-18T00:00:01Z",
  spans: [],
}
const response = (
  content = JSON.stringify({ choice: "Pass", reason: "Matches" })
) => ({
  model: "gpt-4.1-mini-2025-04-14",
  status: "completed",
  output: [
    { type: "reasoning", content: [] },
    { type: "message", content: [{ type: "output_text", text: content }] },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
})

test("direct OpenAI reuses Gateway metadata, filters Gateway aliases, and keeps provider identities separate", () => {
  const source = gatewayModels.find(
    (model) => model.id === "openai/gpt-4.1-mini"
  )!
  const snapshot = structuredClone(source)
  const models = projectModels([
    ...gatewayModels,
    ...["gpt-5.1-thinking", "gpt-4.1-mini-fast", "gpt-oss-120b"].map((id) => ({
      ...source,
      id: `openai/${id}`,
    })),
    { ...source, id: "anthropic/incorrect-creator" },
    { ...source, creator: "other", id: "openai/incorrect-owner" },
  ])
  const direct = models.filter((model) => model.provider === OPENAI_PROVIDER)
  expect(direct.map((model) => model.id)).toEqual([
    "gpt-4.1-mini",
    "text-embedding-3-small",
    "gpt-5.1",
  ])
  expect(direct[0]).toEqual({
    ...source,
    id: "gpt-4.1-mini",
    provider: OPENAI_PROVIDER,
  })
  expect(source).toEqual(snapshot)
  expect(new Set(models.map(modelOptionValue)).size).toBe(models.length)
  expect(models.find((model) => model.id === source.id)?.provider).toBe(
    GATEWAY_PROVIDER
  )
  expect(
    projectModels([]).filter((model) => model.provider === OPENAI_PROVIDER)
  ).toEqual([])
})

test("OpenAI prompt and scorer schemas require direct IDs and reject native evaluation mode", () => {
  expect(scorerInputSchema.parse(config).provider).toBe(OPENAI_PROVIDER)
  expect(
    scorerInputSchema.safeParse({ ...config, modelType: "evaluation" }).success
  ).toBe(false)
  for (const model of ["", "openai/gpt-4.1-mini", "gpt model"]) {
    expect(scorerInputSchema.safeParse({ ...config, model }).success).toBe(
      false
    )
    expect(
      promptConfigSchema.safeParse({
        ...defaultPrompt,
        provider: OPENAI_PROVIDER,
        model,
      }).success
    ).toBe(false)
  }
  for (const model of ["gpt-4.1-mini", "ft:gpt-4.1-mini:org:custom:id"]) {
    expect(scorerInputSchema.safeParse({ ...config, model }).success).toBe(true)
    expect(
      promptConfigSchema.safeParse({
        ...defaultPrompt,
        provider: OPENAI_PROVIDER,
        model,
      }).success
    ).toBe(true)
  }
  expect(
    promptDraftSchema.safeParse({
      ...defaultPrompt,
      name: "Draft",
      slug: "draft",
      provider: OPENAI_PROVIDER,
    }).success
  ).toBe(true)
  expect(
    promptConfigSchema.safeParse({ ...defaultPrompt, model: "gpt-4.1-mini" })
      .success
  ).toBe(false)
})

test("direct OpenAI scorer uses Responses, strict choices, image input, and actual usage", async () => {
  const imageUrl = "https://example.test/image.png"
  const result = await runLlmScorer(
    { ...config, imagePaths: ["output.image"], chainOfThought: true },
    { ...trace, output: { image: imageUrl } },
    null,
    {
      provider: OPENAI_PROVIDER,
      apiKey: "project-openai-key",
      baseUrl: "https://api.openai.com/v1",
      pricing: { autoRefresh: false },
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/responses")
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer project-openai-key"
        )
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe("gpt-4.1-mini")
        expect(body.store).toBe(false)
        expect(body.max_output_tokens).toBe(4096)
        expect(body.text.format).toMatchObject({
          type: "json_schema",
          name: "datool_score",
          strict: true,
          schema: { required: ["reason", "choice"] },
        })
        expect(body.input.at(-1)).toEqual({
          role: "user",
          content: [
            { type: "input_image", image_url: imageUrl, detail: "auto" },
          ],
        })
        return Response.json(response())
      },
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.score).toBe(1)
  expect(result.reasoning).toBe("Matches")
  expect(result.metadata?.judgeProvider).toBe(OPENAI_PROVIDER)
  expect(result.metadata?.judge).toMatchObject({
    provider: "openai",
    model: "gpt-4.1-mini-2025-04-14",
    metrics: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 10,
      reasoningTokens: 5,
    },
  })
})

test("direct OpenAI scorer rejects refusals, partial output, and missing project credentials", async () => {
  for (const body of [
    { ...response(), status: "incomplete" },
    {
      ...response(),
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "sensitive provider text" }],
        },
      ],
    },
  ]) {
    const result = await runLlmScorer(config, trace, null, {
      provider: OPENAI_PROVIDER,
      apiKey: "project-key",
      pricing: { autoRefresh: false },
      fetch: async () => Response.json(body),
    })
    expect(result.score).toBeNull()
    expect(result.error).toBeDefined()
    expect(JSON.stringify(result)).not.toContain("sensitive provider text")
  }
  let called = false
  const result = await runLlmScorer(config, trace, null, {
    provider: OPENAI_PROVIDER,
    fetch: async () => {
      called = true
      return Response.json(response())
    },
  })
  expect(called).toBe(false)
  expect(result.error?.message).toContain("Configure OpenAI")
})

test("OpenAI prompt previews preserve history and JSON settings with direct model IDs", async () => {
  const value = {
    config: {
      ...defaultPrompt,
      provider: OPENAI_PROVIDER,
      model: "gpt-5.2-codex",
      output: "json",
      maxTokens: 1200,
    },
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Reply in JSON" },
    ],
  }
  const result = await previewPrompt(value, "project", {
    apiKey: "project-key",
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses")
      const body = JSON.parse(String(init?.body))
      expect(body.input).toEqual([...value.config.messages, ...value.messages])
      expect(body.model).toBe("gpt-5.2-codex")
      expect(body.text.format).toEqual({ type: "json_object" })
      expect(body.max_output_tokens).toBe(1200)
      expect(body.store).toBe(false)
      return Response.json(response('{"answer":"Hello"}'))
    },
  })
  expect(result.content).toBe('{"answer":"Hello"}')
  await rejects(
    previewPrompt(value, "project", {
      apiKey: "key",
      fetch: async () => Response.json({ ...response(), status: "incomplete" }),
    }),
    /did not complete/
  )
  await rejects(
    previewPrompt(value, "project", {
      apiKey: "key",
      fetch: async () => new Response("secret upstream text", { status: 401 }),
    }),
    /Model request failed \(401\)/
  )
  await rejects(
    previewPrompt(value, "project", {
      apiKey: "key",
      fetch: async () =>
        Response.json({
          ...response(),
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "sensitive text" }],
            },
          ],
        }),
    }),
    /declined this prompt/
  )
})

test("older direct OpenAI models retain Chat Completions", async () => {
  for (const model of ["gpt-3.5-turbo", "gpt-4-turbo"]) {
    const result = await previewPrompt(
      {
        config: {
          ...defaultPrompt,
          provider: OPENAI_PROVIDER,
          model,
          maxTokens: 100,
        },
        messages: [{ role: "user", content: "Hi" }],
      },
      "project",
      {
        apiKey: "project-key",
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://api.openai.com/v1/chat/completions")
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model,
            max_completion_tokens: 100,
            messages: [
              ...defaultPrompt.messages,
              { role: "user", content: "Hi" },
            ],
          })
          return Response.json({ choices: [{ message: { content: "Hello" } }] })
        },
      }
    )
    expect(result.content).toBe("Hello")
  }
})

import { describe, expect, test } from "bun:test"
import { priceLlm } from "../src/lib/tracer/pricing"
import { aggregateLlmUsage, readUsage } from "../src/lib/tracer/usage"
import { usageDisplay } from "../components/tracer/usage-display"
import type { ModelCatalog } from "tokenlens"
import { traceOpenAIChatFetch } from "../src/lib/tracer/openai-fetch"
import { resolveJsonSelector } from "../src/lib/tracer/selectors"

const providers: ModelCatalog = {
  gateway: {
    id: "gateway",
    models: {
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "Free clone",
        cost: { input: 0, output: 0 },
      },
    },
  },
  openai: {
    id: "openai",
    models: {
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        cost: { input: 0.25, output: 2, cache_read: 0.025 },
      },
    },
  },
}
const attrs = {
  "ai.model.provider": "openai.responses",
  "ai.model.id": "gpt-5-mini",
  "gen_ai.response.model": "gpt-5-mini-2025-08-07",
  "ai.usage.inputTokens": 1000,
  "ai.usage.outputTokens": 200,
  "ai.usage.cachedInputTokens": 500,
  "ai.usage.reasoningTokens": 100,
}

describe("persisted model, token and cost accounting", () => {
  test("prices the actual provider, resolves snapshots and does not double-charge cached/reasoning tokens", () => {
    const saved = priceLlm(attrs, providers)
    expect(saved.model).toBe("gpt-5-mini-2025-08-07")
    expect(saved.provider).toBe("openai")
    expect(saved["usage.total_tokens"]).toBe(1200)
    expect(saved["usage.reasoning_tokens"]).toBe(100)
    // 500 uncached input + 500 cached input + 200 output (including reasoning).
    const expected = (500 * 0.25 + 500 * 0.025 + 200 * 2) / 1e6
    expect(Math.abs(Number(saved["cost.usd"]) - expected) < 1e-12).toBe(true)
    expect(saved["cost.model"]).toBe("openai/gpt-5-mini")
    expect(saved["cost.resolution"]).toBe("dated_snapshot_alias")
    expect(saved["cost.status"]).toBe("estimated")
    expect(
      resolveJsonSelector(
        { trace: { attributes: saved } },
        "trace.attributes.metrics.totalTokens"
      )
    ).toBe(1200)
    expect(
      resolveJsonSelector(
        { trace: { attributes: saved } },
        "trace.attributes.metrics.costUsd"
      )
    ).toBe(saved["cost.usd"])
    expect(saved["cost.rates_per_million"]).toEqual(
      providers.openai.models["gpt-5-mini"].cost
    )
  })

  test("keeps unknown models, missing usage and invalid details unavailable rather than free", () => {
    expect(
      priceLlm({ ...attrs, "gen_ai.response.model": "unknown" }, providers)[
        "cost.usd"
      ]
    ).toBeUndefined()
    expect(
      priceLlm(
        { "ai.model.provider": "openai", "ai.model.id": "gpt-5-mini" },
        providers
      )["cost.usd"]
    ).toBeUndefined()
    expect(
      priceLlm({ ...attrs, "ai.usage.cachedInputTokens": 1001 }, providers)[
        "cost.usd"
      ]
    ).toBeUndefined()
    const zero = priceLlm(
      {
        ...attrs,
        "ai.usage.inputTokens": 0,
        "ai.usage.outputTokens": 0,
        "ai.usage.cachedInputTokens": 0,
        "ai.usage.reasoningTokens": 0,
      },
      providers
    )
    expect(zero["cost.usd"]).toBe(0)
    expect(zero["cost.status"]).toBe("estimated")
  })

  test("normalizes both AI SDK and GenAI attributes while preserving missing counters", () => {
    expect(
      readUsage({
        "gen_ai.usage.input_tokens": 50,
        "gen_ai.usage.output_tokens": 70,
        "gen_ai.usage.reasoning.output_tokens": 20,
      })
    ).toMatchObject({ input: 50, output: 70, total: 120, reasoning: 20 })
    expect(readUsage({})).toMatchObject({
      input: undefined,
      output: undefined,
      total: undefined,
    })
  })

  test("rolls up LLM costs and models with explicit missing coverage", () => {
    const first = priceLlm(attrs, providers)
    const second = priceLlm(
      { ...attrs, "gen_ai.response.model": "unpriced-model" },
      providers
    )
    const totals = aggregateLlmUsage([first, second])
    expect(totals["usage.total_tokens"]).toBe(2400)
    expect(totals["usage.status"]).toBe("complete")
    expect(totals["cost.status"]).toBe("partial")
    expect(totals["cost.usd"]).toBeUndefined()
    expect(totals["cost.known_usd"]).toBe(first["cost.usd"])
    expect(totals.models).toEqual(["gpt-5-mini-2025-08-07", "unpriced-model"])
    expect(aggregateLlmUsage([first, {}])["usage.status"]).toBe("partial")
  })

  test("the inspector shows response models, token subsets and precise saved estimates", () => {
    const rows = usageDisplay(priceLlm(attrs, providers))
    expect(Object.fromEntries(rows)).toMatchObject({
      Model: "gpt-5-mini-2025-08-07",
      "Total tokens": "1,200",
      "Reasoning tokens": "100",
      "Estimated cost": "$0.0005375",
    })
  })
})

test("OpenAI judge capture preserves the response and records its actual model and usage", async () => {
  const records: Record<string, unknown>[] = []
  const tracer: Parameters<typeof traceOpenAIChatFetch>[0] = {
    async startActiveSpan(name, options, work) {
      const record: Record<string, unknown> = { name, ...options.attributes }
      records.push(record)
      return work({
        setAttribute: (key, value) => {
          record[key] = value
        },
        setStatus: (status) => {
          record.status = status
        },
        end: () => {
          record.ended = true
        },
      })
    },
  }
  const payload = {
    id: "response-1",
    model: "gpt-4o-2024-08-06",
    choices: [{ message: { role: "assistant", content: "score" } }],
    usage: {
      prompt_tokens: 123,
      completion_tokens: 45,
      total_tokens: 168,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  }
  const wrapped = traceOpenAIChatFetch(tracer, async () =>
    Response.json(payload)
  )
  const response = await wrapped("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "judge" }],
    }),
  })
  expect(await response.json()).toEqual(payload)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    "datool.span.kind": "llm",
    "gen_ai.request.model": "gpt-4o",
    "gen_ai.response.model": "gpt-4o-2024-08-06",
    "gen_ai.usage.input_tokens": 123,
    "gen_ai.usage.output_tokens": 45,
    "gen_ai.usage.cache_read.input_tokens": 20,
    "gen_ai.usage.reasoning.output_tokens": 10,
    ended: true,
  })
  const failing = traceOpenAIChatFetch(
    tracer,
    async () => new Response("rate limited", { status: 429 })
  )
  const failed = await failing("https://api.openai.com/v1/chat/completions", {
    body: '{"model":"gpt-4o"}',
  })
  expect(failed.status).toBe(429)
  expect(records[1]).toMatchObject({
    status: { code: 2, message: "OpenAI HTTP 429" },
    ended: true,
  })
  expect(records[1]["gen_ai.usage.input_tokens"]).toBeUndefined()
})


test("usage display omits unavailable costs but retains reported zero", () => {
  expect(usageDisplay({ "cost.status": "missing" })).toEqual([])
  expect(usageDisplay({ "cost.usd": 0 })).toEqual([["Reported cost", "$0.00"]])
})

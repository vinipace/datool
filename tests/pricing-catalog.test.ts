import { expect, test } from "bun:test"
import type { ModelCatalog } from "tokenlens"
import { PricingCatalog } from "../src/lib/tracer/pricing-catalog"
import { priceLlm, priceLlmWithCatalog } from "../src/lib/tracer/pricing"
import { DatoolSpanProcessor, type OtelSpan } from "../src/lib/tracer/otel"

const close = (actual: unknown, expected: number) =>
  expect(Math.abs(Number(actual) - expected) < 1e-12).toBe(true)

const providers = {
  openai: {
    id: "openai",
    models: {
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "Luna",
        cost: {
          input: 0.2,
          output: 1.2,
          cache_read: 0.02,
          cache_write: 0.25,
          // The explicit threshold must win over this older, misleading key.
          context_over_200k: { input: 0.4, output: 1.8 },
          tiers: [
            {
              tier: { type: "context", size: 272000 },
              input: 0.4,
              output: 1.8,
              cache_read: 0.04,
              cache_write: 0.5,
            },
          ],
        },
      },
    },
  },
} as ModelCatalog
const attrs = (input = 1000) => ({
  "gen_ai.provider.name": "openai",
  "gen_ai.response.model": "gpt-5.6-luna-2026-07-30",
  "gen_ai.usage.input_tokens": input,
  "gen_ai.usage.output_tokens": 1000,
})

test("live catalog is shared by concurrent callers, cached and recorded in quotes", async () => {
  let calls = 0
  const pricing = new PricingCatalog({
    catalog: {},
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe("https://models.dev/api.json")
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeUndefined()
      return Response.json(providers)
    },
  })
  const quotes = await Promise.all(
    Array.from({ length: 10 }, () => priceLlmWithCatalog(attrs(), pricing))
  )
  expect(calls).toBe(1)
  for (const quote of quotes) {
    close(quote["cost.usd"], 0.0014)
    expect(quote["cost.catalog"]).toBe("https://models.dev/api.json")
    expect(typeof quote["cost.catalog_fetched_at"]).toBe("string")
  }
  await pricing.get()
  expect(calls).toBe(1)
})

test("expired catalogs refresh and retain the last good rates on malformed data or outages", async () => {
  let response: unknown = providers
  let calls = 0
  const pricing = new PricingCatalog({
    catalog: {},
    refreshIntervalMs: 0,
    fetch: async () => {
      calls++
      if (response instanceof Error) throw response
      return Response.json(response)
    },
  })
  const first = await pricing.get()
  const changed = structuredClone(providers)
  changed.openai.models["gpt-5.6-luna"].cost!.input = 0.3
  response = changed
  expect(
    (await pricing.get()).providers.openai.models["gpt-5.6-luna"].cost!.input
  ).toBe(0.3)
  response = { error: "unavailable" }
  expect(
    (await pricing.get()).providers.openai.models["gpt-5.6-luna"].cost!.input
  ).toBe(0.3)
  await pricing.get()
  expect(calls).toBe(3)
  expect(first.providers.openai.models["gpt-5.6-luna"].cost!.input).toBe(0.2)

  const unavailable = new PricingCatalog({
    catalog: providers,
    fetch: async () => {
      throw new Error("offline")
    },
  })
  close((await priceLlmWithCatalog(attrs(), unavailable))["cost.usd"], 0.0014)
  const unknown = await priceLlmWithCatalog(
    { ...attrs(), "gen_ai.response.model": "unknown" },
    unavailable
  )
  expect(unknown["cost.status"]).toBe("missing")
  expect(unknown["cost.usd"]).toBeUndefined()
})

test("catalog requests time out without preventing fallback pricing", async () => {
  const pricing = new PricingCatalog({
    catalog: providers,
    timeoutMs: 10,
    fetch: async (_, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(new Error("timeout"))
        )
      ),
  })
  close((await priceLlmWithCatalog(attrs(), pricing))["cost.usd"], 0.0014)
})

test("context rates apply to the whole request and use inclusive input before cache subtraction", () => {
  close(priceLlm(attrs(272000), providers)["cost.usd"], 0.0556)
  const quote = priceLlm(
    {
      ...attrs(272001),
      "gen_ai.usage.cache_read.input_tokens": 100000,
      "gen_ai.usage.cache_creation.input_tokens": 50000,
      "cost.reason": "old failure",
      "cost.usd": 99,
    },
    providers
  )
  close(
    quote["cost.usd"],
    (122001 * 0.4 + 100000 * 0.04 + 50000 * 0.5 + 1000 * 1.8) / 1e6
  )
  expect(quote["cost.context_threshold"]).toBe(272000)
  expect(quote["cost.reason"]).toBeUndefined()
  expect(providers.openai.models["gpt-5.6-luna"].cost!.input).toBe(0.2)
  const invalid = structuredClone(providers)
  invalid.openai.models["gpt-5.6-luna"].cost!.input = -1
  expect(priceLlm(attrs(), invalid)["cost.status"]).toBe("missing")
})

test("forceFlush waits for fresh LLM quotes before wrapper and trace rollups", async () => {
  const saved = new Map<string, Record<string, unknown>>()
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const processor = new DatoolSpanProcessor({
    apiKey: "fixture",
    delivery: "direct",
    pricing: {
      catalog: {},
      fetch: async () => {
        await ready
        return Response.json(providers)
      },
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      const id = body.id ?? String(url).split("/").at(-1)
      saved.set(id, { ...saved.get(id), ...body })
      return Response.json({ data: {} })
    },
  })
  const span = (id: string, kind: string, parent?: string): OtelSpan => ({
    name: id,
    attributes: {
      "datool.span.kind": kind,
      ...(kind === "llm" ? attrs() : {}),
    },
    parentSpanId: parent,
    status: { code: 1 },
    startTime: [1789000000, 0],
    endTime: [1789000001, 0],
    spanContext: () => ({ traceId: "trace", spanId: id }),
  })
  const root = span("workflow", "workflow")
  const agent = span("agent", "function", "workflow")
  const llm = span("model", "llm", "agent")
  for (const s of [root, agent, llm]) processor.onStart(s)
  for (const s of [llm, agent, root]) processor.onEnd(s)
  let flushed = false
  const flushing = processor.forceFlush().then(() => {
    flushed = true
  })
  await Promise.resolve()
  expect(flushed).toBe(false)
  release()
  await flushing
  for (const id of ["model", "agent", "workflow", "trace"]) {
    const attributes = saved.get(id)?.attributes as Record<string, unknown>
    expect(attributes["cost.status"]).toBe("estimated")
    close(attributes["cost.usd"], 0.0014)
  }
  await processor.shutdown()
})

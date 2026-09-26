import { expect, test } from "bun:test"
import { strict as assert } from "node:assert"
import { createGatewayCatalog } from "../src/server/model-providers/catalog"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "../src/server/model-providers/secrets"
import { scorerInputSchema, defaultScorer } from "../src/lib/tracer/scorers"
import { GATEWAY_PROVIDER, modelTokenPrice, modelPriceIndicators, type ModelOption } from "../src/lib/model-providers"

test("provider encryption is randomized, authenticated, and bound to project/provider", () => {
  const previous = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "test-only-encryption-secret-at-least-32-characters"
  try {
    const secret = "test-provider-secret"
    const encrypted = encryptProviderKey(secret, "project-a", GATEWAY_PROVIDER)
    expect(encrypted).not.toContain(secret)
    expect(encryptProviderKey(secret, "project-a", GATEWAY_PROVIDER)).not.toBe(
      encrypted
    )
    expect(decryptProviderKey(encrypted, "project-a", GATEWAY_PROVIDER)).toBe(
      secret
    )
    expect(() =>
      decryptProviderKey(encrypted, "project-b", GATEWAY_PROVIDER)
    ).toThrow("Unable to unlock")
    expect(() =>
      decryptProviderKey(encrypted, "project-a", "other-provider")
    ).toThrow("Unable to unlock")
    const parts = encrypted.split(".")
    parts[3] = Buffer.from("tampered").toString("base64url")
    expect(() =>
      decryptProviderKey(parts.join("."), "project-a", GATEWAY_PROVIDER)
    ).toThrow("Unable to unlock")
  } finally {
    if (previous === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previous
  }
})

test("catalog coalesces requests, strips extraneous data, caches and retains stale results", async () => {
  let now = 10000000
  let calls = 0
  let fail = false
  const catalog = createGatewayCatalog(
    (async (url, init) => {
      calls++
      expect(String(url)).toBe("https://ai-gateway.vercel.sh/v1/models")
      expect(init?.headers).toBeUndefined()
      if (fail) return new Response("upstream error", { status: 503 })
      return Response.json({
        data: [
          {
            id: "openai/test",
            name: "Test",
            owned_by: "openai",
            type: "language",
            private: "omit",
            tags: ["tool-use"],
            description: "A test model.",
            context_window: 200000,
            max_tokens: 8192,
            pricing: {
              input: "0.000015",
              output: "0.000075",
              input_cache_read: "0",
              input_tiers: [
                { min: 0, max: 200000, cost: "0.000015" },
                { min: 200000, cost: "0.00003" },
              ],
            },
          },
          { id: "broken" },
        ],
      })
    }) as typeof fetch,
    () => now
  )
  const [first, second] = await Promise.all([catalog(), catalog()])
  expect(calls).toBe(1)
  expect(first).toEqual(second)
  expect(first.models).toHaveLength(1)
  expect(first.models[0]).toMatchObject({
    description: "A test model.",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    pricing: {
      input: "0.000015",
      output: "0.000075",
      cacheRead: "0",
      inputTiers: [
        { min: 0, max: 200000, cost: "0.000015" },
        { min: 200000, cost: "0.00003" },
      ],
    },
  })
  expect(JSON.stringify(first)).not.toContain("private")
  await catalog()
  expect(calls).toBe(1)
  now += 3600001
  fail = true
  expect((await catalog()).stale).toBe(true)
  expect((await catalog()).models).toEqual(first.models)
  expect(calls).toBe(2)
  now += 60001
  fail = false
  expect((await catalog()).stale).toBe(false)
  expect(calls).toBe(3)
})

test("model pricing converts per-token rates, preserves free prices and handles missing/tiered rates", () => {
  expect(modelTokenPrice("0.000015")).toBe("$15.00 / million tokens")
  expect(modelTokenPrice("0.0000004")).toBe("$0.40 / million tokens")
  expect(modelTokenPrice("0")).toBe("$0.00 / million tokens")
  for (const value of [undefined, "", "invalid", "-1", "Infinity"])
    expect(modelTokenPrice(value)).toBe("Not available")
  expect(
    modelTokenPrice("0.000003", [{ cost: "0.000006" }, { cost: "0.000003" }])
  ).toBe("$3.00–$6.00 / million tokens")
})

test("catalog without a snapshot fails safely and backs off", async () => {
  let calls = 0
  const catalog = createGatewayCatalog((async () => {
    calls++
    throw new Error("sensitive upstream message")
  }) as typeof fetch)
  await assert.rejects(catalog(), /Unable to load the model catalog/)
  await assert.rejects(catalog(), /Unable to load the model catalog/)
  expect(calls).toBe(1)
})

test("price pies compress expensive outliers, keep free distinct from unknown, and include tiers", () => {
  const model = (id: string, dollars?: number): ModelOption => ({
    id, name: id, creator: "test", type: "language", tags: [],
    pricing: dollars === undefined ? undefined : { input: String(dollars / 1e6), output: String(dollars / 1e6) },
  })
  const prices = modelPriceIndicators([
    model("free", 0), model("cheap", .1), model("medium", 5), model("expensive", 200), model("max", 500), model("unknown"),
    { ...model("tiered", 1), pricing: { inputTiers: [{ cost: ".0005", min: 0 }], output: ".0005" } },
    { ...model("partial", 1), pricing: { input: ".000001" } },
  ])
  expect(prices.get("free")).toEqual({ fraction: 0, level: "Free" })
  expect(prices.get("cheap")?.level).toBe("Cheap")
  expect(prices.get("medium")?.level).toBe("Medium")
  expect(prices.get("medium")!.fraction).toBeGreaterThan(.4)
  expect(prices.get("expensive")!.fraction).toBeGreaterThan(.85)
  expect(prices.get("max")).toEqual({ fraction: 1, level: "Expensive" })
  expect(prices.get("tiered")).toEqual(prices.get("max"))
  expect(prices.get("unknown")).toBeUndefined()
  expect(prices.get("partial")).toBeUndefined()
})

test("Gateway configs require qualified IDs; legacy configs remain unchanged", () => {
  const config = {
    ...defaultScorer,
    name: "Judge",
    slug: "judge",
    model: "gpt-4.1-mini",
  }
  expect(scorerInputSchema.parse(config).provider).toBeUndefined()
  expect(
    scorerInputSchema.safeParse({ ...config, provider: GATEWAY_PROVIDER })
      .success
  ).toBe(false)
  expect(
    scorerInputSchema.parse({
      ...config,
      provider: GATEWAY_PROVIDER,
      model: "openai/gpt-4.1-mini",
    }).provider
  ).toBe(GATEWAY_PROVIDER)
  expect(
    scorerInputSchema.safeParse({ ...config, provider: "unknown" }).success
  ).toBe(false)
})

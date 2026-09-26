import { expect, test } from "bun:test"
import {
  planCostBackfill,
  type CostBackfillSpan,
} from "../src/lib/tracer/cost-backfill"
import type { PricingSnapshot } from "../src/lib/tracer/pricing-catalog"
import type { JsonObject } from "../src/lib/tracer/contracts"

const snapshot: PricingSnapshot = {
  source: "fixture",
  fetchedAt: "2026-09-13T00:00:00Z",
  providers: {
    openai: {
      id: "openai",
      models: {
        "gpt-5.1": {
          id: "gpt-5.1",
          name: "GPT-5.1",
          cost: { input: 1.25, output: 10, cache_read: 0.125 },
        },
      },
    },
  },
}
const missing: JsonObject = {
  model: "gpt-5.1",
  provider: "openai",
  "cost.status": "missing",
  "usage.input_tokens": 1000,
  "usage.output_tokens": 100,
  "usage.cache_read_tokens": 200,
}
const span = (
  id: string,
  kind: string,
  parentId: string | null,
  attributes: JsonObject
): CostBackfillSpan => ({ id, kind, parentId, attributes })

test("backfill repairs missing model quotes and reconciles parents without changing priced siblings", () => {
  const spans = [
    span("agent", "function", null, {
      keep: true,
      "usage.total_tokens": 1400,
      "cost.status": "partial",
      "cost.known_usd": 2,
    }),
    span("missing", "llm", "agent", missing),
    span("priced", "llm", "agent", {
      ...missing,
      "cost.status": "estimated",
      "cost.usd": 2,
    }),
    span("unrelated", "task", null, { "cost.usd": 999 }),
  ]
  const result = planCostBackfill(
    { user: "keep", "cost.status": "partial", "cost.known_usd": 2 },
    spans,
    snapshot,
    "gpt-5.1",
    "run"
  )
  expect(result.priced).toBe(1)
  expect(result.changed.size).toBe(2)
  expect(result.changed.has("priced")).toBe(false)
  expect(result.changed.has("unrelated")).toBe(false)
  expect(result.addedUsd).toBe(0.002025)
  expect(result.trace?.["cost.usd"]).toBe(2.002025)
  expect(result.trace?.user).toBe("keep")
  expect(result.changed.get("agent")?.["usage.total_tokens"]).toBe(1400)
  expect(result.changed.get("agent")?.keep).toBe(true)
  expect((result.changed.get("agent")?.metrics as JsonObject).costUsd).toBe(
    2.002025
  )
  const again = planCostBackfill(
    result.trace!,
    spans.map((s) => ({
      ...s,
      attributes: result.changed.get(s.id) ?? s.attributes,
    })),
    snapshot,
    "gpt-5.1",
    "again"
  )
  expect(again.priced).toBe(0)
  expect(again.changed.size).toBe(0)
})

test("missing usage stays unknown and keeps inclusive costs partial", () => {
  const spans = [
    span("wrapper", "task", null, { "cost.usd": 999 }),
    span("priced-now", "llm", "wrapper", missing),
    span("unknown", "llm", "wrapper", {
      model: "sonar",
      "cost.status": "missing",
    }),
  ]
  const result = planCostBackfill({}, spans, snapshot, "gpt-5.1", "run")
  expect(result.priced).toBe(1)
  expect(result.trace?.["cost.status"]).toBe("partial")
  expect(result.trace?.["cost.usd"]).toBeUndefined()
  expect(result.trace?.["cost.known_usd"]).toBe(0.002025)
  expect(result.changed.get("wrapper")?.["cost.usd"]).toBeUndefined()
  expect(result.changed.has("unknown")).toBe(false)
  expect(
    planCostBackfill(
      {},
      [
        span("missing-usage", "llm", null, {
          model: "gpt-5.1",
          provider: "openai",
          "cost.status": "missing",
        }),
      ],
      snapshot,
      "gpt-5.1",
      "run"
    ).priced
  ).toBe(0)
})

test("backfill rejects cycles and does not mutate original attributes", () => {
  const spans = [
    span("a", "task", "b", {}),
    span("b", "task", "a", {}),
    span("model", "llm", "a", missing),
  ]
  expect(() => planCostBackfill({}, spans, snapshot, "gpt-5.1", "run")).toThrow(
    "Cyclic"
  )
  expect(missing["cost.usd"]).toBeUndefined()
})

test("rollups exclude partial, negative and nonfinite LLM cost values", () => {
  const spans = [
    span("new", "llm", null, missing),
    ...[
      [-1, "estimated"],
      [Infinity, "estimated"],
      [99, "partial"],
    ].map(([cost, status], i) =>
      span(`invalid-${i}`, "llm", null, {
        "cost.usd": cost,
        "cost.status": status,
      })
    ),
  ]
  const result = planCostBackfill({}, spans, snapshot, "gpt-5.1", "run")
  expect(result.trace?.["cost.status"]).toBe("partial")
  expect(result.trace?.["cost.known_usd"]).toBe(0.002025)
  expect(result.trace?.["cost.usd"]).toBeUndefined()
})

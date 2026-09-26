import { describe, expect, test } from "bun:test"
import {
  pairEvalRows,
  parseCompareIds,
  evalComparisonUrl,
  averageEvalScore,
  comparableScore,
  type EvalComparisonRow,
} from "@/src/lib/tracer/eval-comparison"
import type { EvalResult, JsonValue } from "@/src/lib/tracer/contracts"

function row(
  id: string,
  input: JsonValue = null,
  item: string | null = null,
  traceId = id
): EvalComparisonRow {
  return {
    id,
    datasetItemId: item,
    expectedOutput: null,
    results: [],
    trace: {
      id: traceId,
      input,
      output: null,
      name: id,
      attributes: {},
      durationMs: null,
      endedAt: null,
      startedAt: "2026-09-07T00:00:00Z",
      status: "completed",
      operation: "test",
      sessionId: null,
    },
  }
}
describe("eval comparison", () => {
  test("numeric comparisons retain zero and failed scores, and exclude unavailable evidence", () => {
    const result: EvalResult = {
      completedAt: null, datasetItemId: null, error: null, evaluatorId: "judge", evaluatorName: "Judge", evaluatorVersion: 1,
      id: "result", metadata: {}, passed: false, reasoning: null, runId: "run", score: 0, status: "failed", traceId: "trace",
    }
    expect(comparableScore(result)).toBe(0)
    expect(comparableScore({ ...result, status: "completed", score: 0.8 })).toBe(0.8)
    expect(comparableScore({ ...result, status: "error", score: 1 })).toBeNull()
    expect(comparableScore({ ...result, error: "Judge failed", score: 1 })).toBeNull()
    expect(comparableScore({ ...result, metadata: { skipped: true }, score: 1 })).toBeNull()
    expect(comparableScore({ ...result, score: NaN })).toBeNull()
    expect(averageEvalScore(undefined)).toBeNull()
    expect(averageEvalScore({ ...row("empty"), results: [{ ...result, score: null }] })).toBeNull()
    expect(averageEvalScore({ ...row("mixed"), results: [result, { ...result, score: 0.8 }, { ...result, status: "error", score: 1 }] })).toBe(0.4)
  })
  test("matches dataset targets even when inputs change and row order differs", () => {
    const pairs = pairEvalRows(
      [row("a", "old", "item1"), row("b", "second", "item2")],
      [row("c", "second", "item2"), row("d", "new", "item1")]
    )
    expect(
      pairs.map((pair) => [pair.left?.id, pair.right?.id, pair.matchedBy])
    ).toEqual([
      ["a", "d", "dataset item"],
      ["b", "c", "dataset item"],
    ])
  })
  test("uses trace identity before input, and matches JSON inputs regardless of object key order", () => {
    const pairs = pairEvalRows(
      [row("a", null, null, "same"), row("b", { x: 1, y: [2] })],
      [row("c", { y: [2], x: 1 }), row("d", null, null, "same")]
    )
    expect(pairs.map((pair) => [pair.right?.id, pair.matchedBy])).toEqual([
      ["d", "trace"],
      ["c", "input"],
    ])
  })
  test("retains ambiguous duplicates, missing inputs and unmatched rows without arbitrary pairing", () => {
    const pairs = pairEvalRows(
      [row("a", "duplicate"), row("b", "duplicate"), row("c")],
      [row("d", "duplicate"), row("e"), row("f", "new")]
    )
    expect(pairs).toHaveLength(6)
    expect(pairs.filter((pair) => pair.left && pair.right)).toHaveLength(0)
  })
})


describe("comparison URLs", () => {
  test("round trips three runs and preserves unrelated query parameters", () => {
    const url = new URL(evalComparisonUrl(["x", "y", "z"], "view=saved&compare=old"), "http://localhost")
    expect(url.pathname).toBe("/evals")
    expect(url.search).toBe("?compare=x,y,z&view=saved")
    expect(parseCompareIds(url.searchParams.get("compare"))).toEqual(["x", "y", "z"])
  })
  test("ignores empty and duplicate IDs while preserving baseline order", () => {
    expect(parseCompareIds("x,, y,x,z,")).toEqual(["x", "y", "z"])
    expect(parseCompareIds(null)).toEqual([])
    expect(evalComparisonUrl(["x", "x", "y"])).toBe("/evals?compare=x,y")
  })
})

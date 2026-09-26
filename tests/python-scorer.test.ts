import { describe, expect, test } from "bun:test"
import type { TraceForEvaluation } from "../src/lib/tracer/contracts"
import { defaultScorer, defaultPythonScorerCode, scorerInputSchema } from "../src/lib/tracer/scorers"
import { runPythonEvaluator } from "../src/server/sandbox/evaluator"
import { executeScorer } from "../src/server/tracer/scorer-runtime"

const trace: TraceForEvaluation = {
  id: "python-test", name: "Python test", operation: "test", status: "completed",
  sessionId: null, startedAt: "2026-09-15T00:00:00Z", endedAt: null,
  input: "question", output: { answer: "42" }, attributes: {}, spans: [],
}
const datasetItem = { id: "case", datasetId: "dataset", sourceTraceId: null,
  input: "question", expectedOutput: { answer: "42" }, metadata: {} }

describe("Python scorers", () => {
  test("validates configuration and executes the starter against real evidence", async () => {
    const config = { ...defaultScorer, type: "python", name: "Python", slug: "python", code: defaultPythonScorerCode }
    expect(scorerInputSchema.safeParse(config).success).toBe(true)
    expect(scorerInputSchema.safeParse({ ...config, code: " " }).success).toBe(false)
    expect(await runPythonEvaluator({ code: config.code, trace, datasetItem })).toMatchObject({ score: 1, passed: true })
    expect(await runPythonEvaluator({ code: config.code, trace, datasetItem: { ...datasetItem, expectedOutput: "wrong" } })).toMatchObject({ score: 0, passed: false })
  })

  test("supports standard-library scoring, metadata and reasons; print does not break results", async () => {
    const result = await runPythonEvaluator({ trace, code: `import re
from statistics import mean

def evaluate(trace, dataset_item=None):
    print("debug output")
    return {"score": mean([0.5, 1]), "reason": re.sub("test", "works", "test"), "label": "quality", "metrics": {"count": 2}, "metadata": {"custom": True}}
` })
    expect(result).toMatchObject({ score: 0.75, passed: null, reasoning: "works", metadata: { label: "quality", metrics: { count: 2 }, custom: true } })
  })

  for (const [code, kind] of [
    ['def evaluate(trace, dataset_item=None):\n    return {"score": 3}', "validation"],
    ['def evaluate(trace, dataset_item=None):\n    return {"score": float("nan")}', "validation"],
    ['def evaluate(trace, dataset_item=None):\n    return {"score": 1, "passed": "yes"}', "validation"],
    ['def evaluate(trace, dataset_item=None):\n    return {"score": 1, "reasoning": "wrong key"}', "validation"],
    ['def evaluate(trace, dataset_item=None):\n    return {"score": 1, "metrics": {"bad": {1, 2}}}', "validation"],
    ['def evaluate(trace, dataset_item=None):\n    return {"score": 1, "reason": "a" * 20000}', "validation"],
    ["def evaluate(:", "runtime"],
    ["x = 1", "validation"],
    ['def evaluate(trace, dataset_item=None):\n    raise ValueError("Broken scorer")', "runtime"],
    ['import os\ndef evaluate(trace, dataset_item=None):\n    return {"score": 1}', "runtime"],
    ['def evaluate(trace, dataset_item=None):\n    open("/etc/passwd")', "runtime"],
  ]) test(`reports bounded failures: ${code}`, async () => {
    expect(await runPythonEvaluator({ code, trace })).toMatchObject({ score: null, passed: null, error: { kind } })
  })

  test("kills loops and bounds output", async () => {
    expect(await runPythonEvaluator({ trace, timeoutMs: 150, code: "while True: pass" })).toMatchObject({ error: { kind: "timeout" } })
    expect(await runPythonEvaluator({ trace, code: 'print("x" * 40000)' })).toMatchObject({ error: { kind: "sandbox" } })
  })

  test("routes saved Python versions and applies the shared pass threshold", async () => {
    const version = { id: "version", evaluatorId: "scorer", version: 1, createdAt: trace.startedAt,
      language: "python" as const, code: 'def evaluate(trace, dataset_item=None):\n    return {"score": 0.6}',
      config: { ...defaultScorer, type: "python" as const, threshold: 0.7 },
    }
    expect(await executeScorer(version, trace)).toMatchObject({ score: 0.6, passed: false })
    expect(await executeScorer({ ...version, config: undefined }, trace)).toMatchObject({ score: 0.6, passed: null })
  })
})

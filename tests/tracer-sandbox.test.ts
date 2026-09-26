import { describe, expect, test } from "bun:test"

import type { TraceForEvaluation } from "@/src/lib/tracer/contracts"
import { runEvaluator } from "@/src/server/sandbox/evaluator"

const trace = {
  attributes: { demo: true },
  endedAt: "2026-09-06T12:00:01.000Z",
  id: "tr_sandbox_test",
  input: { question: "What must be checked before launch?" },
  name: "Sandbox test trace",
  operation: "test.workflow",
  output: {
    answer: {
      text: "Before launch, verify the source record and approval status.",
    },
  },
  sessionId: "ses_sandbox_test",
  spans: [],
  startedAt: "2026-09-06T12:00:00.000Z",
  status: "completed",
} satisfies TraceForEvaluation

describe("local evaluator sandbox", () => {
  test("runs a synchronous evaluator and preserves only its declared metadata", async () => {
    const result = await runEvaluator({
      code: `function evaluate({ trace, datasetItem }) {
        const expected = datasetItem?.expectedOutput?.mustInclude
        const answer = trace.output?.answer?.text ?? ""
        const passed = typeof expected === "string" && answer.includes(expected)
        return {
          score: passed ? 1 : 0,
          passed,
          label: "required phrase",
          reason: passed ? "Expected phrase found" : "Expected phrase missing",
          metrics: { answerLength: answer.length },
        }
      }`,
      datasetItem: {
        datasetId: "ds_sandbox_test",
        expectedOutput: { mustInclude: "verify the source record" },
        id: "dsi_sandbox_test",
        input: { question: "What must be checked before launch?" },
        metadata: {},
        sourceTraceId: null,
      },
      trace,
    })

    expect(result).toEqual({
      metadata: {
        label: "required phrase",
        metrics: { answerLength: 60 },
      },
      passed: true,
      reasoning: "Expected phrase found",
      score: 1,
    })
  })

  test("supports asynchronous evaluators", async () => {
    const result = await runEvaluator({
      code: `async function evaluate({ trace }) {
        await Promise.resolve()
        return { score: trace.status === "completed" ? 0.75 : 0, passed: true }
      }`,
      trace,
    })

    expect(result).toEqual({ metadata: {}, passed: true, score: 0.75 })
  })

  test("fails closed for malformed evaluator output", async () => {
    const result = await runEvaluator({
      code: "function evaluate() { return { score: 2 }; }",
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("validation")
  })

  test("rejects a reasoning typo instead of silently dropping it", async () => {
    const result = await runEvaluator({
      code: `function evaluate() {
        return { score: 1, passed: true, reasoning: "Use reason instead" }
      }`,
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("validation")
    expect(result.error?.message).toContain("Use reason, not reasoning")
  })

  test("rejects syntax-invalid JavaScript", async () => {
    const result = await runEvaluator({
      code: "function evaluate( { return { score: 1 }",
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("runtime")
  })

  test("kills a synchronous infinite loop", async () => {
    const startedAt = Date.now()
    const result = await runEvaluator({
      code: "function evaluate() { while (true) {} }",
      timeoutMs: 80,
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("timeout")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  test("kills an unresolved asynchronous evaluator", async () => {
    const result = await runEvaluator({
      code: "async function evaluate() { return new Promise(() => {}) }",
      timeoutMs: 80,
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("timeout")
  })

  test("does not expose Node or browser capability globals to evaluator code", async () => {
    const result = await runEvaluator({
      code: `function evaluate() {
        const prohibited = [
          "process", "require", "module", "Buffer", "fetch", "WebSocket",
          "XMLHttpRequest", "setTimeout", "setInterval", "console",
        ]
        const noGlobals = prohibited.every((key) => typeof globalThis[key] === "undefined")
        let constructorsCannotReachProcess = false
        try {
          const getProcess = ({}).constructor.constructor("return typeof process")
          constructorsCannotReachProcess = getProcess() === "undefined"
        } catch {
          constructorsCannotReachProcess = true
        }
        return {
          score: noGlobals && constructorsCannotReachProcess ? 1 : 0,
          passed: noGlobals && constructorsCannotReachProcess,
        }
      }`,
      trace,
    })

    expect(result).toEqual({ metadata: {}, passed: true, score: 1 })
  })

  test("does not permit dynamic module imports", async () => {
    const result = await runEvaluator({
      code: `async function evaluate() {
        await import("node:fs")
        return { score: 1, passed: true }
      }`,
      trace,
    })

    expect(result.score).toBeNull()
    expect(result.passed).toBeNull()
    expect(result.error?.kind).toBe("runtime")
  })
})

import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import {
  judgeTransport,
  providerDiagnostic,
  RuntimeCircuit,
  diagnosticResult,
} from "../src/server/tracer/runtime-diagnostics"
import { runLlmScorer } from "../src/server/tracer/llm-scorer"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { runSandboxScorer } from "../src/server/sandbox/run-scorer"
import {
  checkCalibration,
  type CalibrationJudgment,
} from "../src/lib/tracer/calibration"
import fixtures from "../examples/scorer-calibration/brand-extraction.json"

test("429 diagnostics retain safe identifiers and distinguish rate limits from explicit quota", async () => {
  const plain = await providerDiagnostic(
    Response.json(
      {
        error: {
          code: "rate_limit_exceeded",
          message: "secret-body sk-do-not-expose",
        },
      },
      {
        status: 429,
        headers: { "x-request-id": "req_123", "retry-after": "120" },
      }
    )
  )
  expect(plain).toMatchObject({
    category: "rate_limit",
    providerCode: "rate_limit_exceeded",
    requestId: "req_123",
    retryAfter: "120",
    httpStatus: 429,
  })
  expect(JSON.stringify(plain)).not.toContain("secret-body")
  expect(JSON.stringify(plain)).not.toContain("sk-do-not-expose")
  const quota = await providerDiagnostic(
    Response.json(
      { error: { code: "insufficient_quota", message: "secret" } },
      { status: 429 }
    )
  )
  expect(quota.category).toBe("quota")
  const direct = await providerDiagnostic(
    Response.json(
      {
        error_type: "insufficient_credits",
        detail: "private TypeSafe account information",
      },
      { status: 429 }
    )
  )
  expect(direct).toMatchObject({
    category: "quota",
    providerCode: "insufficient_credits",
  })
  expect(JSON.stringify(direct)).not.toContain("private TypeSafe")
  const huge = await providerDiagnostic(
    new Response("x".repeat(40000), {
      status: 429,
      headers: { "request-id": "sk-secret", "retry-after": "arbitrary secret" },
    })
  )
  expect(huge.requestId).toBeUndefined()
  expect(huge.retryAfter).toBeUndefined()
})

test("judge retries are bounded, honor Retry-After, and never retry explicit quota or authentication failures", async () => {
  for (const scenario of [
    { status: 429, code: "rate_limit_exceeded", after: "0.4", calls: 2 },
    { status: 429, code: "rate_limit_exceeded", after: "120", calls: 1 },
    { status: 429, code: "insufficient_quota", after: "0", calls: 1 },
    { status: 401, code: "invalid_api_key", after: "0", calls: 1 },
  ]) {
    let calls = 0
    const sleeps: number[] = []
    const transport = judgeTransport(
      async () => {
        calls++
        return Response.json(
          { error: { code: scenario.code } },
          {
            status: scenario.status,
            headers: { "retry-after": scenario.after },
          }
        )
      },
      10000,
      async (ms) => {
        sleeps.push(ms)
      }
    )
    await rejects(transport.fetch("https://provider.test/judge"))
    expect(calls).toBe(scenario.calls)
    if (scenario.calls === 2) expect(sleeps[0]).toBeGreaterThanOrEqual(400)
    else expect(sleeps.length).toBe(0)
  }
})

test("persistent failures stop a concurrent dataset cascade; valid zero scores do not", async () => {
  const circuit = new RuntimeCircuit()
  let calls = 0
  const results = await Promise.all(
    Array.from({ length: 30 }, () =>
      circuit.run("provider:model", async () => {
        calls++
        return diagnosticResult({
          category: "rate_limit",
          message: "Rate limited",
        })
      })
    )
  )
  expect(calls).toBe(1)
  expect(results.filter((r) => r.metadata?.runtimeCircuitOpen).length).toBe(29)
  expect(results.every((r) => r.score === null && r.error)).toBe(true)
  let qualityCalls = 0
  for (let i = 0; i < 3; i++)
    await circuit.run("healthy", async () => {
      qualityCalls++
      return { score: 0, passed: false }
    })
  expect(qualityCalls).toBe(3)
})

test("missing provider and unavailable sandbox are execution failures, not quality scores", async () => {
  const result = await runLlmScorer(
    { ...defaultScorer, type: "llm" },
    {
      id: "fixture",
      name: "Fixture",
      operation: "test",
      sessionId: null,
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: null,
      input: null,
      output: null,
      attributes: {},
      spans: [],
    },
    null,
    { provider: "typesafe-ai" }
  )
  expect(result.metadata?.runtimeDiagnostic).toMatchObject({
    category: "configuration",
  })
  expect(result.score).toBeNull()
  const sandbox = await runSandboxScorer(
    "project",
    "javascript",
    { code: "function evaluate(){return {score:1}}", trace: {} as never },
    {
      providers: async () => [
        { id: "local", credentials: () => ({ provider: "local" }) },
      ],
      execute: async () => {
        throw new Error("private infrastructure detail")
      },
    }
  )
  expect(sandbox.error?.kind).toBe("sandbox")
  expect(sandbox.score).toBeNull()
  expect(JSON.stringify(sandbox)).not.toContain("private infrastructure detail")
})

test("calibration fixtures expose criteria mixing, unsupported placeholder brands and missing evidence", () => {
  const judgments = fixtures.fixtures.flatMap((f) =>
    Object.entries(f.expectedJudgments).map(([criterion, judgment]) => ({
      fixtureId: f.id,
      criterion,
      judgment: judgment as CalibrationJudgment,
    }))
  )
  expect(checkCalibration(fixtures.fixtures, judgments).passed).toBe(true)
  const mixed = judgments.map((j) =>
    j.fixtureId === "loading-placeholder-unsupported-brands" &&
    j.criterion === "coverage"
      ? { ...j, judgment: "fail" as const }
      : j
  )
  expect(checkCalibration(fixtures.fixtures, mixed)).toMatchObject({
    passed: false,
    mismatches: [
      {
        fixtureId: "loading-placeholder-unsupported-brands",
        criterion: "coverage",
        expected: "pass",
        actual: "fail",
      },
    ],
  })
  const falseGrounding = judgments.map((j) =>
    j.fixtureId === "loading-placeholder-unsupported-brands" &&
    j.criterion === "grounding"
      ? { ...j, judgment: "pass" as const }
      : j
  )
  expect(checkCalibration(fixtures.fixtures, falseGrounding).passed).toBe(false)
  expect(
    checkCalibration(
      fixtures.fixtures,
      judgments.filter((j) => j.fixtureId !== "missing-evidence")
    ).passed
  ).toBe(false)
})

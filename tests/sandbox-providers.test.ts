import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import type {
  TraceForEvaluation,
  EvaluatorRunResult,
} from "../src/lib/tracer/contracts"
import {
  sandboxCredentialsSchema,
  sandboxExecutionOrder,
  sandboxProviderInputSchema,
  type SandboxProviderId,
  type SandboxCredentials,
} from "../src/lib/sandbox-providers"
import { runSandboxScorer } from "../src/server/sandbox/run-scorer"
import {
  decodeSandboxResult,
  executeSandboxProvider,
} from "../src/server/sandbox/provider-runtime"

export const trace: TraceForEvaluation = {
  id: "sandbox-test",
  name: "Sandbox test",
  operation: "test",
  sessionId: null,
  status: "completed",
  startedAt: "2026-09-17T12:00:00Z",
  endedAt: null,
  input: "hello",
  output: "hello",
  attributes: {},
  spans: [],
}
const input = {
  code: "function evaluate({trace}) { return {score: trace.input === trace.output ? 1 : 0} }",
  trace,
}
const configs: SandboxCredentials[] = [
  {
    provider: "vercel",
    apiKey: "secret",
    teamId: "team",
    projectId: "project",
  },
  { provider: "local" },
  { provider: "modal", tokenId: "id", tokenSecret: "secret" },
]
const providers = async () =>
  configs.map((config) => ({ id: config.provider, credentials: () => config }))

test("default runs first, followed only by configured providers in stable order", () => {
  expect(sandboxExecutionOrder(["local", "vercel", "modal"], "modal")).toEqual([
    "modal",
    "local",
    "vercel",
  ])
  expect(sandboxExecutionOrder(["vercel"], "vercel")).toEqual(["vercel"])
  expect(sandboxExecutionOrder([], null)).toEqual([])
  expect(
    sandboxProviderInputSchema.safeParse({
      provider: "local",
      apiKey: "unexpected",
    }).success
  ).toBe(false)
  expect(
    sandboxProviderInputSchema.safeParse({ provider: "modal", tokenSecret: "" })
      .success
  ).toBe(false)
  expect(
    sandboxCredentialsSchema.safeParse({ provider: "modal", tokenId: "id" })
      .success
  ).toBe(false)
})

test("provider startup or credential failure falls back without leaking credentials", async () => {
  const calls: SandboxProviderId[] = []
  const result = await runSandboxScorer("project", "javascript", input, {
    providers,
    execute: async (config) => {
      calls.push(config.provider)
      if (config.provider === "vercel")
        throw new Error("secret provider response")
      return { score: 1, passed: null }
    },
  })
  expect(calls).toEqual(["vercel", "local"])
  expect(result).toMatchObject({
    score: 1,
    metadata: {
      sandboxProvider: "local",
      sandboxAttempts: [
        { provider: "vercel", status: "unavailable" },
        { provider: "local", status: "completed" },
      ],
    },
  })
  expect(JSON.stringify(result)).not.toContain("secret")
})

test("scorer failures, timeout and zero scores never run fallbacks", async () => {
  const results: EvaluatorRunResult[] = [
    { score: 0, passed: false },
    ...(
      ["runtime", "validation", "timeout", "sandbox", "protocol"] as const
    ).map((kind) => ({
      score: null,
      passed: null,
      error: { kind, message: "scorer failed" },
    })),
  ]
  for (const outcome of results) {
    let calls = 0
    const result = await runSandboxScorer("project", "javascript", input, {
      providers,
      execute: async () => {
        calls++
        return outcome
      },
    })
    expect(calls).toBe(1)
    expect(result.score).toBe(outcome.score)
    expect(result.error).toEqual(outcome.error)
  }
})

test("an unreadable credential falls back without executing that provider", async () => {
  const calls: SandboxProviderId[] = []
  const result = await runSandboxScorer("project", "javascript", input, {
    providers: async () => [
      {
        id: "vercel",
        credentials: () => {
          throw new Error("cannot decrypt secret")
        },
      },
      { id: "local", credentials: () => ({ provider: "local" }) },
    ],
    execute: async (config) => {
      calls.push(config.provider)
      return { score: 1, passed: true }
    },
  })
  expect(calls).toEqual(["local"])
  expect(result.metadata?.sandboxProvider).toBe("local")
  expect(JSON.stringify(result)).not.toContain("secret")
})

test("exhausted, empty and unreadable project configurations fail closed", async () => {
  const execute = async () => {
    throw new Error("secret")
  }
  expect(
    await runSandboxScorer("project", "python", input, { providers, execute })
  ).toMatchObject({
    error: { kind: "sandbox" },
    metadata: {
      sandboxAttempts: configs.map((config) => ({
        provider: config.provider,
        status: "unavailable",
      })),
    },
  })
  expect(
    await runSandboxScorer("project", "python", input, {
      providers: async () => [],
      execute,
    })
  ).toMatchObject({
    error: {
      message:
        "Configure a sandbox provider in project settings to run code scorers.",
    },
  })
  const failed = await runSandboxScorer("project", "python", input, {
    providers: async () => {
      throw new Error("secret")
    },
    execute,
  })
  expect(JSON.stringify(failed)).not.toContain("secret")
  expect(failed.error?.kind).toBe("sandbox")
})

test("input and worker protocol are validated before accepting results", async () => {
  let called = false
  expect(
    (
      await runSandboxScorer(
        "project",
        "javascript",
        { ...input, code: " " },
        {
          providers: async () => {
            called = true
            return []
          },
          execute: executeSandboxProvider,
        }
      )
    ).error?.kind
  ).toBe("validation")
  expect(called).toBe(false)
  expect(
    decodeSandboxResult('{"ok":true,"result":{"score":100}}', 0).error?.kind
  ).toBe("protocol")
  expect(
    decodeSandboxResult("invalid secret output", 0).error?.message
  ).not.toContain("secret")
})

if (process.env.DATOOL_TEST_SANDBOX_CONTAINERS === "1")
  describe("real Docker scorer containers", () => {
    test("an unreachable Docker daemon falls back instead of becoming a scorer error", async () => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--eval",
          `
            import { runSandboxScorer } from "./src/server/sandbox/run-scorer.ts";
            import { executeSandboxProvider } from "./src/server/sandbox/provider-runtime.ts";
            const result = await runSandboxScorer("project", "javascript", ${JSON.stringify(input)}, {
              providers: async () => [
                { id: "local", credentials: () => ({provider: "local"}) },
                { id: "modal", credentials: () => ({provider: "modal", tokenId: "test", tokenSecret: "test"}) },
              ],
              execute: (config, job) => config.provider === "local"
                ? executeSandboxProvider(config, job)
                : Promise.resolve({score: 1, passed: true}),
            });
            console.log(JSON.stringify(result));
          `,
        ],
        {
          env: {
            ...process.env,
            DOCKER_HOST: `unix:///tmp/datool-no-daemon-${randomUUID()}.sock`,
            DOCKER_CONTEXT: "",
            DOCKER_TLS_VERIFY: "",
          },
          timeout: 15000,
        }
      )
      expect(JSON.parse(result.stdout)).toMatchObject({
        score: 1,
        metadata: {
          sandboxProvider: "modal",
          sandboxAttempts: [
            { provider: "local", status: "unavailable" },
            { provider: "modal", status: "completed" },
          ],
        },
      })
    }, 20000)
    const run = (
      language: "javascript" | "python",
      code: string,
      timeoutMs = 1000
    ) =>
      executeSandboxProvider(
        { provider: "local" },
        {
          language,
          payload: JSON.stringify({ code, trace, timeoutMs }),
          timeoutMs,
        }
      )
    test("JavaScript and Python execute inside isolated containers", async () => {
      expect(await run("javascript", input.code)).toMatchObject({
        score: 1,
        passed: null,
      })
      expect(
        await run(
          "python",
          'def evaluate(trace, dataset_item=None):\n return {"score": trace["input"] == trace["output"], "reason": "ação ✓"}'
        )
      ).toMatchObject({ score: 1, reasoning: "ação ✓" })
    }, 60000)
    test("code cannot access host environment, filesystem or network", async () => {
      expect(
        await run(
          "javascript",
          'function evaluate() { return {score: typeof process === "undefined" && typeof fetch === "undefined" ? 1 : 0} }'
        )
      ).toMatchObject({ score: 1 })
      expect(
        (
          await run(
            "python",
            'def evaluate(trace, dataset_item=None):\n return {"score": open("/etc/passwd").read()}'
          )
        ).error
      ).toBeDefined()
    }, 60000)
    test("infinite loops and excessive output are bounded", async () => {
      expect(
        (await run("javascript", "function evaluate() { while(true) {} }", 100))
          .error?.kind
      ).toBe("timeout")
      expect((await run("python", "while True: pass", 100)).error?.kind).toBe(
        "timeout"
      )
      expect((await run("python", 'print("x" * 40000)')).error?.kind).toBe(
        "sandbox"
      )
    }, 60000)
  })

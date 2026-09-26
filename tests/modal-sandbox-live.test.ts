import { test } from "bun:test"
import assert from "node:assert/strict"
import { setTimeout as pause } from "node:timers/promises"
import { ModalClient, SandboxService } from "modal"
import type { TraceForEvaluation } from "../src/lib/tracer/contracts"
import { runSandboxScorer } from "../src/server/sandbox/run-scorer"

// Opt in explicitly: this uses billable Modal sandboxes and real credentials.
// DATOOL_TEST_MODAL=1 MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... \
//   bun test tests/modal-sandbox-live.test.ts
if (process.env.DATOOL_TEST_MODAL === "1")
  test("Modal executes bounded scorers and stops every sandbox after success, failure, and timeout", async () => {
    const tokenId = process.env.MODAL_TOKEN_ID
    const tokenSecret = process.env.MODAL_TOKEN_SECRET
    if (!tokenId || !tokenSecret)
      throw new Error(
        "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET for this test."
      )

    const observer = new ModalClient({
      tokenId,
      tokenSecret,
      timeoutMs: 15000,
      maxRetries: 0,
    })
    const sandboxIds: string[] = []
    const create = SandboxService.prototype.create
    // Observe real SDK creations without replacing any remote execution.
    SandboxService.prototype.create = async function (
      this: SandboxService,
      ...args: Parameters<typeof create>
    ) {
      const sandbox = await create.apply(this, args)
      sandboxIds.push(sandbox.sandboxId)
      return sandbox
    }
    const trace: TraceForEvaluation = {
      id: "modal-live-test",
      name: "Modal live test",
      operation: "test",
      sessionId: null,
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: null,
      input: "hello",
      output: "hello",
      attributes: {},
      spans: [],
    }
    const cases = [
      {
        name: "javascript success",
        language: "javascript",
        code: "function evaluate({ trace }) { return { score: trace.input === trace.output ? 1 : 0, passed: true } }",
        score: 1,
      },
      {
        name: "javascript zero score",
        language: "javascript",
        code: "function evaluate() { return { score: 0, passed: false } }",
        score: 0,
      },
      {
        name: "javascript error",
        language: "javascript",
        code: 'function evaluate() { throw new Error("expected test failure") }',
        error: "runtime",
      },
      {
        name: "javascript timeout",
        language: "javascript",
        code: "function evaluate() { while (true) {} }",
        error: "timeout",
      },
      {
        name: "python success",
        language: "python",
        code: 'def evaluate(trace, dataset_item=None):\n return {"score": 1, "passed": True}',
        score: 1,
      },
      {
        name: "python error",
        language: "python",
        code: 'def evaluate(trace, dataset_item=None):\n raise ValueError("expected test failure")',
        error: "runtime",
      },
      {
        name: "python output limit",
        language: "python",
        code: 'print("x" * 40000)\ndef evaluate(trace, dataset_item=None):\n return {"score": 1}',
        error: "sandbox",
      },
      {
        name: "python timeout",
        language: "python",
        code: "while True: pass",
        error: "timeout",
      },
      {
        name: "javascript recovery",
        language: "javascript",
        code: "function evaluate() { return { score: 1, passed: true } }",
        score: 1,
      },
    ] as const

    try {
      for (const item of cases) {
        const before = sandboxIds.length
        const started = Date.now()
        const result = await runSandboxScorer(
          "modal-live-test",
          item.language,
          {
            code: item.code,
            trace,
            timeoutMs: 1000,
          },
          {
            providers: async () => [
              {
                id: "modal",
                credentials: () => ({
                  provider: "modal",
                  tokenId,
                  tokenSecret,
                }),
              },
            ],
          }
        )
        console.log(
          JSON.stringify({
            case: item.name,
            stage: "returned",
            result,
            elapsedMs: Date.now() - started,
          })
        )
        assert.equal(sandboxIds.length, before + 1, item.name)
        const sandboxId = sandboxIds[before]
        const sandbox = await observer.sandboxes.fromId(sandboxId)
        let exitCode: number | null = null
        try {
          const deadline = Date.now() + 5000
          do {
            exitCode = await sandbox.poll()
            if (exitCode !== null) break
            await pause(100)
          } while (Date.now() < deadline)
          assert.notEqual(exitCode, null, `${item.name}: sandbox must stop`)
        } finally {
          sandbox.detach()
        }
        assert.equal(result.metadata?.sandboxProvider, "modal", item.name)
        if ("error" in item)
          assert.equal(result.error?.kind, item.error, item.name)
        else {
          assert.equal(result.error, undefined, item.name)
          assert.equal(result.score, item.score, item.name)
        }
        console.log(
          JSON.stringify({
            case: item.name,
            sandboxId,
            score: result.score,
            error: result.error?.kind ?? null,
            sandboxExitCode: exitCode,
            elapsedMs: Date.now() - started,
          })
        )
      }
    } finally {
      SandboxService.prototype.create = create
      // Also clean up after a failed assertion; never terminate unrelated work.
      try {
        for (const sandboxId of sandboxIds) {
          const sandbox = await observer.sandboxes.fromId(sandboxId)
          try {
            if ((await sandbox.poll()) === null)
              await sandbox.terminate({ wait: true })
          } finally {
            sandbox.detach()
          }
        }
      } finally {
        observer.close()
      }
    }
  }, 180_000)

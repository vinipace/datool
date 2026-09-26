import { afterEach, expect, test } from "bun:test"
import { appRequest } from "../bin/request"
import { agentCommand } from "../bin/agent"
import { rejects } from "node:assert/strict"

const original = {
  fetch: globalThis.fetch,
  project: process.env.DATOOL_PROJECT_ID,
  key: process.env.DATOOL_API_KEY,
  info: console.info,
  error: console.error,
}
afterEach(() => {
  globalThis.fetch = original.fetch
  console.info = original.info
  console.error = original.error
  for (const [key, value] of [
    ["DATOOL_PROJECT_ID", original.project],
    ["DATOOL_API_KEY", original.key],
  ]) {
    if (value === undefined) delete process.env[key!]
    else process.env[key!] = value
  }
})

test("CLI sends explicit project scope on reads and mutations", async () => {
  process.env.DATOOL_PROJECT_ID = " project-a "
  process.env.DATOOL_API_KEY = " test-key "
  const requests: RequestInit[] = []
  globalThis.fetch = async (_input, init) => {
    requests.push(init!)
    return Response.json({ data: { ok: true } })
  }
  await appRequest("http://localhost:3000", "/api/apps/config")
  await appRequest("http://localhost:3000", "/api/resources", { dryRun: true })
  expect(requests.map((request) => request.method)).toEqual(["GET", "POST"])
  for (const request of requests) {
    expect(new Headers(request.headers).get("x-project-id")).toBe("project-a")
    expect(new Headers(request.headers).get("authorization")).toBe(
      "Bearer test-key"
    )
    expect(request.redirect).toBe("error")
  }
})

test("CLI rejects missing project scope before sending and hides upstream errors", async () => {
  delete process.env.DATOOL_PROJECT_ID
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return new Response("private upstream body", { status: 403 })
  }
  await rejects(
    appRequest("http://localhost", "/api/apps"),
    /DATOOL_PROJECT_ID/
  )
  expect(requests).toBe(0)
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  await rejects(appRequest("http://localhost", "/api/apps"), /HTTP 403/)
})

test("CLI reports only recognized permission details and never upstream secret text", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: "secret-key",
          details: {
            reason: "INSUFFICIENT_SCOPE",
            missingScopes: ["traces:read", "secret-key"],
          },
        },
      },
      { status: 403 }
    )
  await rejects(appRequest("http://localhost", "/api/traces"), (error) => {
    expect((error as Error).message).toContain(
      "Missing permission: traces:read"
    )
    expect((error as Error).message).not.toContain("secret-key")
    return true
  })
})

test("read-only requests survive throttling and retain sanitized cooldown details", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  let calls = 0
  globalThis.fetch = async () =>
    ++calls === 1
      ? Response.json(
          {
            error: { message: "secret", details: { retryAfterSeconds: 0.01 } },
          },
          { status: 429, headers: { "Retry-After": "0.01" } }
        )
      : Response.json({ data: "complete" })
  expect(
    await appRequest(
      "http://localhost",
      "/api/agent/get_eval_run",
      {},
      { retry: "read" }
    )
  ).toBe("complete")
  expect(calls).toBe(2)
})

test("mutations remain single-shot and cooldown metadata cannot expose upstream text", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json(
      {
        error: {
          code: "secret",
          message: "secret",
          details: { retryAfterSeconds: 65 },
        },
      },
      { status: 429, headers: { "Retry-After": "30" } }
    )
  }
  await rejects(
    appRequest("http://localhost", "/api/agent/start_eval_run", {
      requestKey: "same",
    }),
    (error) => {
      expect(error).toMatchObject({
        status: 429,
        retryAfterMs: 65_000,
        category: "throttled",
      })
      expect(String(error)).not.toContain("secret")
      return true
    }
  )
  expect(calls).toBe(1)
  await rejects(
    appRequest(
      "http://localhost",
      "/api/agent/get_eval_run",
      {},
      { retry: "read", retryBudgetMs: 10 }
    ),
    /HTTP 429/
  )
  expect(calls).toBe(2)
})

test("retry guidance accepts dates and malformed guidance uses bounded backoff", async () => {
  const { retryDelayMs, retryBackoffMs } =
    await import("../src/lib/tracer/retry")
  const now = Date.parse("2026-09-19T12:00:00Z")
  expect(retryDelayMs("Sat, 19 Sep 2026 12:01:05 GMT", 30, now)).toBe(65_000)
  expect(retryDelayMs("invalid", -1, now)).toBe(0)
  expect(retryDelayMs("NaN", Infinity, now)).toBe(0)
  expect(retryBackoffMs(100)).toBeLessThanOrEqual(10_000)
  expect(retryBackoffMs(0, 65_000)).toBe(65_000)
})

test("analytics aliases and generic agent calls retry busy reads at the command boundary", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  const output: string[] = []
  console.info = (message: string) => {
    output.push(message)
  }
  console.error = () => {}
  try {
    for (const [operation, alias] of [
      ["get_metrics_metadata", ["metrics", "metadata"]],
      ["query_metrics", ["metrics", "query"]],
      ["batch_metrics", ["metrics", "batch"]],
      ["preview_dashboard", ["dashboards", "preview", "dashboard-id"]],
    ] as const) {
      for (const command of [alias, ["agent", "call", operation]]) {
        const attempts: number[] = []
        globalThis.fetch = async (input, init) => {
          expect(new URL(String(input)).pathname).toBe(
            `/api/agent/${operation}`
          )
          expect(init?.method).toBe("POST")
          attempts.push(Date.now())
          return attempts.length === 1
            ? Response.json(
                {
                  error: {
                    code: "READ_BUSY",
                    details: { retryAfterSeconds: 0.01 },
                  },
                },
                { status: 429 }
              )
            : Response.json({ data: { recovered: true } })
        }
        expect(await agentCommand([...command])).toBe(0)
        expect(attempts).toHaveLength(2)
        expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(10)
        expect(output.at(-1)).toBe(JSON.stringify({ recovered: true }, null, 2))
      }
    }
  } finally {
    console.info = original.info
    console.error = original.error
  }
})

test("analytics retry allowlist excludes mutations and permanent authorization failures", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  console.error = () => {}
  try {
    for (const [command, status] of [
      [["agent", "call", "start_eval_run"], 429],
      [["dashboards", "create"], 429],
      [["metrics", "query"], 401],
    ] as const) {
      let attempts = 0
      globalThis.fetch = async () => {
        attempts++
        return Response.json({ error: { code: "READ_BUSY" } }, { status })
      }
      expect(await agentCommand([...command])).toBe(1)
      expect(attempts).toBe(1)
    }
  } finally {
    console.error = original.error
  }
})

test("CLI lets a healthy metrics batch outlast the old ten-second timeout without replay", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  console.info = () => {}
  console.error = () => {}
  let attempts = 0
  globalThis.fetch = async (_input, init) => {
    attempts++
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      const aborted = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", aborted)
        resolve(Response.json({ data: [] }))
      }, 10_100)
      signal?.addEventListener("abort", aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }
  expect(await agentCommand(["metrics", "batch"])).toBe(0)
  expect(attempts).toBe(1)
}, 15000)

import { afterEach, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { agentCommand, exportPages, waitForEval } from "../bin/agent"
import { resourcesCommand } from "../bin/resources"

const initial = {
  fetch: globalThis.fetch,
  info: console.info,
  error: console.error,
  project: process.env.DATOOL_PROJECT_ID,
  key: process.env.DATOOL_API_KEY,
}
afterEach(() => {
  globalThis.fetch = initial.fetch
  console.info = initial.info
  console.error = initial.error
  for (const [key, value] of [
    ["DATOOL_PROJECT_ID", initial.project],
    ["DATOOL_API_KEY", initial.key],
  ]) {
    if (value === undefined) delete process.env[key!]
    else process.env[key!] = value
  }
})

test("CLI promotes exact spans, exposes readiness/probes and prints a saved run link before waiting", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  const requests: { operation: string; body: unknown }[] = []
  const messages: string[] = []
  console.info = () => {}
  console.error = message => { messages.push(String(message)) }
  globalThis.fetch = async (url, init) => {
    const operation = String(url).split("/api/agent/")[1]
    requests.push({ operation, body: JSON.parse(String(init?.body)) })
    if (operation === "get_eval_run") expect(messages[0]).toContain("https://datool.test/p/demo/evals/run-1")
    return Response.json({ data: { id: "run-1", url: "https://datool.test/p/demo/evals/run-1", status: "completed" } })
  }
  expect(await agentCommand(["datasets", "promote", "ds-1", "--input", '{"spans":[{"traceId":"t","spanId":"s"}]}'])).toBe(0)
  expect(requests[0]).toEqual({ operation: "promote_spans", body: { datasetId: "ds-1", spans: [{ traceId: "t", spanId: "s" }] } })
  expect(await agentCommand(["scorers", "check", "--input", '{"scorerIds":["s"]}'])).toBe(0)
  expect(requests[1].operation).toBe("check_scorer_runtime")
  expect(await agentCommand(["scorers", "probe", "--input", '{"scorerIds":["s"],"traceId":"t"}'])).toBe(0)
  expect(requests[2].operation).toBe("probe_scorer_runtime")
  expect(await agentCommand(["evals", "run", "--input", '{"traceIds":["t"],"evaluatorIds":["s"],"requestKey":"key"}', "--wait"])).toBe(0)
  expect(requests[4].operation).toBe("get_eval_run")
  expect(await agentCommand(["scorers", "libraries"])).toBe(0)
  expect(requests[5].operation).toBe("list_scorer_libraries")
  expect(await agentCommand(["scorers", "use-library", "--input", '{"evaluator":"ExactMatch"}'])).toBe(0)
  expect(requests[6]).toMatchObject({ operation: "use_library_scorer", body: { evaluator: "ExactMatch" } })
})

test("CLI maps typed flags and JSON input to shared operations and returns a failing gate exit code", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const output: string[] = []
  console.info = (message) => {
    output.push(String(message))
  }
  console.error = () => {}
  globalThis.fetch = async (url, init) => {
    expect(new Headers(init?.headers).get("x-project-id")).toBe("project-a")
    const path = String(url).split("/api/agent/")[1]
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    return Response.json({
      data:
        path === "gate_eval_run"
          ? { passed: false, reasons: ["Regression"] }
          : { items: [], nextCursor: null },
    })
  }
  expect(
    await agentCommand([
      "traces",
      "list",
      "--limit",
      "12",
      "--include-total",
      "--filter",
      'status = "errored"',
    ])
  ).toBe(0)
  expect(requests[0]).toEqual({
    path: "list_traces",
    body: { limit: 12, includeTotal: true, filter: 'status = "errored"' },
  })
  expect(
    await agentCommand([
      "scorers",
      "test",
      "--input",
      '{"traceId":"t","scorerId":"s"}',
    ])
  ).toBe(0)
  expect(requests[1].body).toEqual({ traceId: "t", scorerId: "s" })
  expect(
    await agentCommand([
      "evals",
      "gate",
      "run-a",
      "--min-score",
      "0.9",
      "--allow-unscored",
      "false",
    ])
  ).toBe(2)
  expect(requests[2].body).toEqual({
    id: "run-a",
    minScore: 0.9,
    allowUnscored: false,
  })
  expect(JSON.parse(output[2]).passed).toBe(false)
  expect(
    await agentCommand([
      "evals",
      "rescore",
      "run-a",
      "--request-key",
      "stable",
      "--input",
      '{"evaluatorIds":["s"]}',
    ])
  ).toBe(0)
  expect(requests[3].body).toEqual({
    sourceRunId: "run-a",
    requestKey: "stable",
    evaluatorIds: ["s"],
  })
  expect(await agentCommand(["traces", "list", "--limit"])).toBe(1)
  expect(await agentCommand(["connect", "handler.ts"])).toBeNull()
})

test("NDJSON exports page incrementally, preserve existing files, and return a resumable bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datool-export-test-"))
  const path = join(dir, "traces.ndjson")
  const seen: unknown[] = []
  const call = async (_name: string, input: Record<string, unknown>) => {
    seen.push(input)
    return input.cursor
      ? { items: [{ id: "b" }], nextCursor: "b" }
      : { items: [{ id: "a" }], nextCursor: "a" }
  }
  try {
    const result = await exportPages(
      call,
      "list_traces",
      { filter: "name : test" },
      path,
      2
    )
    expect(await readFile(path, "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n')
    expect(result.complete).toBe(false)
    expect(result.nextCursor).toBe("b")
    expect(seen).toEqual([
      { filter: "name : test", limit: 2 },
      { filter: "name : test", limit: 1, cursor: "a" },
    ])
    await rejects(exportPages(call, "list_traces", {}, path, 1), /exist/i)
    expect(await readFile(path, "utf8")).toContain('"b"')
    await rejects(
      exportPages(
        async () => ({ items: [], nextCursor: "stalled" }),
        "list_traces",
        {},
        join(dir, "stalled")
      ),
      /stalled/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("evaluation waits stop on every terminal state and time out without starting another run", async () => {
  for (const terminal of ["completed", "failed", "partial", "cancelled"]) {
    let calls = 0
    const result = await waitForEval(
      async (name) => {
        expect(name).toBe("get_eval_run")
        return { id: "r", status: ++calls > 1 ? terminal : "running" }
      },
      "r",
      1,
      0.1
    )
    expect(result.status).toBe(terminal)
  }
  await rejects(
    waitForEval(async () => ({ status: "running" }), "r", 0.1, 0.1),
    /still running/
  )
})

test("resource sync never sends another project's revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datool-sync-scope-"))
  const file = join(dir, "dataset.json")
  process.env.DATOOL_PROJECT_ID = "project-b"
  process.env.DATOOL_API_KEY = "test-key"
  console.info = () => {}
  try {
    await writeFile(
      file,
      JSON.stringify({ format: 1, kind: "dataset", key: "cases", items: [] })
    )
    await writeFile(
      `${file}.datool-sync.json`,
      JSON.stringify({
        origin: "http://localhost",
        projectId: "project-a",
        kind: "dataset",
        key: "cases",
        revision: "foreign-revision",
      })
    )
    let body: Record<string, unknown> = {}
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        data: { revision: "new-revision", conflict: false, changes: [] },
      })
    }
    await resourcesCommand([
      "datasets",
      "push",
      file,
      "--datool",
      "http://localhost",
    ])
    expect(body.expectedRevision).toBeUndefined()
    expect(
      JSON.parse(await readFile(`${file}.datool-sync.json`, "utf8")).projectId
    ).toBe("project-b")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("CLI exposes app discovery, registration and runs while retaining apps sync", async () => {
  process.env.DATOOL_PROJECT_ID = "project-a"
  process.env.DATOOL_API_KEY = "test-key"
  const requests: { operation: string; input: unknown }[] = []
  console.info = () => {}
  globalThis.fetch = async (url, init) => {
    requests.push({ operation: String(url).split("/api/agent/")[1], input: JSON.parse(String(init?.body)) })
    return Response.json({ data: {} })
  }
  expect(await agentCommand(["apps", "sync", "manifest.ts"])).toBe(null)
  expect(await agentCommand(["apps", "list"])).toBe(0)
  expect(await agentCommand(["apps", "get", "echo"])).toBe(0)
  expect(await agentCommand(["apps", "register", "--input", '{"app":{"id":"echo"}}'])).toBe(0)
  expect(await agentCommand(["apps", "run", "echo", "--input", '{"input":{"text":"hello"},"requestKey":"one","scorerIds":[]}'])).toBe(0)
  expect(requests).toEqual([
    { operation: "list_apps", input: {} },
    { operation: "get_app", input: { id: "echo" } },
    { operation: "register_app", input: { app: { id: "echo" } } },
    { operation: "run_app", input: { id: "echo", input: { text: "hello" }, requestKey: "one", scorerIds: [] } },
  ])
})

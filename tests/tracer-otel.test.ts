import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"

import { DatoolSpanProcessor } from "../src/lib/tracer/otel.ts"
import { DatoolClient } from "../src/lib/tracer/client.ts"
import type { JsonObject } from "../src/lib/tracer/contracts"
import {
  assertTracerMutationOrigin,
  getTracerRequestProjectId,
  validateTracerApiKeyBinding,
} from "../src/server/tracer/http"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect } from "../src/server/tracer/effect"
import {
  parseCreateTrace,
  parseCreateSpan,
  parsePatchTrace,
  parsePatchSpan,
} from "../src/server/tracer/validation"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

const traceId = "0123456789abcdef0123456789abcdef"
function span(
  id: string,
  name: string,
  parent?: string,
  attributes: Record<string, unknown> = {}
) {
  return {
    name,
    attributes,
    startTime: [1_789_000_000, 0] as [number, number],
    endTime: [1_789_000_001, 0] as [number, number],
    status: { code: 1 },
    parentSpanContext: parent ? { spanId: parent } : undefined,
    spanContext: () => ({ spanId: id, traceId }),
  }
}

describe("Datool OpenTelemetry ingestion", () => {
  let service: TracerService
  let database: TracerDatabase
  let target: IsolatedPostgres
  beforeAll(async () => {
    target = await createIsolatedPostgres()
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    service = new TracerService(database)
  })
  afterAll(async () => {
    await closeTracerDatabase(database)
    await target.close()
  })

  test("exports task and score siblings with function/LLM/tool nesting and sums only the three LLM calls", async () => {
    const saved = new Map<string, Record<string, unknown>>()
    let root: Record<string, unknown> = {}
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        const body = JSON.parse(String(init?.body))
        if (
          path === "/api/traces" ||
          (path.startsWith("/api/traces/") && !path.endsWith("/spans"))
        )
          root = { ...root, ...body }
        else if (path.endsWith("/spans")) {
          parseCreateSpan(body)
          saved.set(body.id, body)
        } else {
          const id = path.split("/").at(-1)!
          saved.set(id, { ...saved.get(id), ...body })
        }
        return Response.json({ data: {} })
      },
    })
    const make = (
      id: string,
      name: string,
      parent?: string,
      attrs: Record<string, unknown> = {}
    ) => span(id, name, parent, attrs)
    const rootSpan = make("case", "case", undefined, {
      "datool.trace.root": true,
    })
    const task = make("task", "task", "case", { "datool.span.kind": "task" })
    const fn = make("fn", "ai.generateText", "task", {
      "ai.usage.inputTokens": 99999,
      "ai.usage.outputTokens": 99999,
    })
    const usage = {
      "ai.model.provider": "openai.responses",
      "ai.model.id": "gpt-5-mini",
      "ai.usage.inputTokens": 10,
      "ai.usage.outputTokens": 20,
    }
    const first = make("first", "ai.generateText.doGenerate", "fn", usage)
    const tool = make("tool", "ai.toolCall", "first")
    const second = make("second", "ai.generateText.doGenerate", "fn", usage)
    const score = make("score", "Factuality", "case", {
      "datool.span.kind": "score",
    })
    const judge = make("judge", "openai.chat.completions", "score", {
      ...usage,
      "datool.span.kind": "llm",
    })
    for (const s of [rootSpan, task, fn, first, tool]) processor.onStart(s)
    for (const s of [tool, first]) processor.onEnd(s)
    processor.onStart(second)
    for (const s of [second, fn, task]) processor.onEnd(s)
    processor.onStart(score)
    processor.onStart(judge)
    for (const s of [judge, score, rootSpan]) processor.onEnd(s)
    await processor.shutdown()
    expect(saved.has("case")).toBe(false)
    expect(saved.size).toBe(7)
    expect([...saved.values()].map((s) => [s.id, s.kind, s.parentId])).toEqual([
      ["task", "task", null],
      ["fn", "function", "task"],
      ["first", "llm", "fn"],
      ["tool", "tool", "first"],
      ["second", "llm", "fn"],
      ["score", "score", null],
      ["judge", "llm", "score"],
    ])
    const attrs = root.attributes as JsonObject
    expect(attrs["usage.total_tokens"]).toBe(90)
    expect(attrs["usage.llm_calls"]).toBe(3)
    expect(attrs["cost.status"]).toBe("estimated")
    expect(
      (saved.get("fn")?.attributes as JsonObject)["usage.total_tokens"]
    ).toBe(60)
    expect(
      (saved.get("score")?.attributes as JsonObject)["usage.total_tokens"]
    ).toBe(30)
    const sum = ["first", "second", "judge"].reduce(
      (total, id) =>
        total + Number((saved.get(id)?.attributes as JsonObject)["cost.usd"]),
      0
    )
    expect(attrs["cost.usd"]).toBe(sum)
  })

  test("persists starts, nested model/tool spans and final payloads through the actual backend", async () => {
    const requests: string[] = []
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:3000",
      attributes: { project: "test" },
      fetch: (async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer test-key"
        )
        const path = new URL(url).pathname
        requests.push(`${init.method} ${path}`)
        const body = JSON.parse(String(init.body))
        const data = await runTracerEffect<unknown>(
          path === "/api/traces"
            ? service.createTrace(parseCreateTrace(body))
            : path.endsWith("/spans")
              ? service.createSpan(traceId, parseCreateSpan(body))
              : path.startsWith("/api/spans/")
                ? service.patchSpan(
                    path.split("/").at(-1)!,
                    parsePatchSpan(body)
                  )
                : service.patchTrace(traceId, parsePatchTrace(body))
        )
        return Response.json({ data })
      }) as typeof fetch,
    })
    const root = span("0000000000000001", "ai.generateText", undefined, {
      "ai.prompt": JSON.stringify({ prompt: "weather?" }),
      "ai.telemetry.functionId": "mock-weather",
    })
    const model = span(
      "0000000000000002",
      "ai.generateText.doGenerate",
      root.spanContext().spanId
    )
    const tool = span(
      "0000000000000003",
      "ai.toolCall",
      model.spanContext().spanId,
      { "ai.toolCall.args": '{"city":"São Paulo"}' }
    )
    processor.onStart(root)
    processor.onStart(model)
    processor.onStart(tool)
    await processor.forceFlush()
    const running = await runTracerEffect(service.getTrace(traceId))
    expect(running.status).toBe("running")
    expect(running.spans).toHaveLength(3)
    tool.attributes["ai.toolCall.result"] =
      '{"temperatureCelsius":24,"mock":true}'
    model.attributes["ai.usage.inputTokens"] = 25
    model.attributes["ai.response.toolCalls"] = '[{"toolName":"getWeather"}]'
    root.attributes["ai.response.text"] = "Mock weather: 24°C and sunny."
    processor.onEnd(tool)
    processor.onEnd(model)
    processor.onEnd(root)
    await processor.shutdown()
    const saved = await runTracerEffect(service.getTrace(traceId))
    expect(saved.name).toBe("mock-weather")
    expect(saved.status).toBe("completed")
    expect(saved.input).toEqual({ prompt: "weather?" })
    expect(saved.output).toBe("Mock weather: 24°C and sunny.")
    expect(
      saved.spans.find((s) => s.id === tool.spanContext().spanId)
    ).toMatchObject({
      kind: "tool",
      parentId: model.spanContext().spanId,
      input: { city: "São Paulo" },
      output: { temperatureCelsius: 24, mock: true },
      durationMs: 1000,
    })
    expect(
      saved.spans.find((s) => s.id === model.spanContext().spanId)
    ).toMatchObject({
      kind: "llm",
      attributes: { "ai.usage.inputTokens": 25 },
      output: { text: "", toolCalls: [{ toolName: "getWeather" }] },
    })
    expect(requests[0]).toBe("POST /api/traces")
    expect(requests.at(-1)).toBe(`PATCH /api/traces/${traceId}`)
  })

  test("flush and shutdown reject failed exports, without leaking response bodies", async () => {
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      fetch: async () =>
        new Response("secret upstream payload", { status: 401 }),
    })
    const root = span("0000000000000004", "ai.generateText")
    processor.onStart(root)
    processor.onEnd(root)
    await rejects(processor.forceFlush(), /HTTP 401/)
    await rejects(processor.shutdown(), /HTTP 401/)
  })

  test("retains an error from a nested span on its trace", async () => {
    const bodies: Record<string, unknown>[] = []
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ data: {} })
      },
    })
    const root = span("0000000000000005", "ai.generateText")
    const tool = span(
      "0000000000000006",
      "ai.toolCall",
      root.spanContext().spanId
    )
    tool.status.code = 2
    processor.onStart(root)
    processor.onStart(tool)
    processor.onEnd(tool)
    processor.onEnd(root)
    await processor.forceFlush()
    expect(bodies.at(-1)?.status).toBe("errored")
  })

  test("keeps the trace running when a child outlives the root and retains the root output", async () => {
    const patches: { path: string; body: Record<string, unknown> }[] = []
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      fetch: async (url, init) => {
        if (init?.method === "PATCH")
          patches.push({
            path: String(url),
            body: JSON.parse(String(init.body)),
          })
        return Response.json({ data: {} })
      },
    })
    const root = span("0000000000000007", "ai.generateText", undefined, {
      "ai.response.text": "root answer",
    })
    const child = span(
      "0000000000000008",
      "ai.toolCall",
      root.spanContext().spanId
    )
    child.status.code = 2
    child.endTime = [1_789_000_002, 0]
    processor.onStart(root)
    processor.onStart(child)
    processor.onEnd(root)
    await processor.forceFlush()
    expect(patches.some((patch) => patch.path.includes("/api/traces/"))).toBe(
      false
    )
    processor.onEnd(child)
    await processor.shutdown()
    expect(patches.at(-1)?.body).toMatchObject({
      output: "root answer",
      status: "errored",
      endedAt: new Date(1_789_000_002_000).toISOString(),
    })
  })
})

test("tracer HTTP guards require a project-bound SDK key or trusted browser origin", () => {
  const previousKey = process.env.DATOOL_API_KEY
  const previousProject = process.env.DATOOL_PROJECT_ID
  const previousAuthUrl = process.env.BETTER_AUTH_URL
  try {
    process.env.DATOOL_API_KEY = "test-key"
    process.env.DATOOL_PROJECT_ID = "project-a"
    process.env.BETTER_AUTH_URL = "https://app.example.test"
    const request = (
      headers: Record<string, string> = {},
      projectId = "project-a"
    ) =>
      new Request(
        `https://app.example.test/api/traces?projectId=${projectId}`,
        {
          method: "POST",
          headers: { "x-project-id": projectId, ...headers },
        }
      )
    expect(() =>
      getTracerRequestProjectId(
        new Request("https://app.example.test/api/traces")
      )
    ).toThrow("A project ID is required")
    expect(() =>
      getTracerRequestProjectId(
        new Request("https://app.example.test/api/traces?projectId=project-a", {
          headers: { "x-project-id": "project-b" },
        })
      )
    ).toThrow("must match")
    expect(() =>
      validateTracerApiKeyBinding(
        request({ authorization: "Bearer wrong" }),
        "project-a"
      )
    ).toThrow("Missing or invalid")
    expect(() =>
      validateTracerApiKeyBinding(
        request({ authorization: "Bearer test-key" }),
        "project-b"
      )
    ).toThrow("not authorized for this project")
    expect(() =>
      validateTracerApiKeyBinding(
        request({ authorization: "Bearer test-key" }),
        "project-a"
      )
    ).not.toThrow()
    expect(() =>
      assertTracerMutationOrigin(
        request({ origin: "https://app.example.test" })
      )
    ).not.toThrow()
    expect(() =>
      assertTracerMutationOrigin(request({ origin: "https://evil.test" }))
    ).toThrow("origin is not trusted")
    expect(() =>
      assertTracerMutationOrigin(
        request({ authorization: "Bearer test-key" }, "project-b")
      )
    ).not.toThrow()
    delete process.env.DATOOL_PROJECT_ID
    expect(() =>
      validateTracerApiKeyBinding(
        request({ authorization: "Bearer test-key" }),
        "project-a"
      )
    ).toThrow("requires DATOOL_PROJECT_ID")
    delete process.env.DATOOL_API_KEY
    expect(() => new DatoolClient()).toThrow("Missing DATOOL_API_KEY")
  } finally {
    if (previousKey === undefined) delete process.env.DATOOL_API_KEY
    else process.env.DATOOL_API_KEY = previousKey
    if (previousProject === undefined) delete process.env.DATOOL_PROJECT_ID
    else process.env.DATOOL_PROJECT_ID = previousProject
    if (previousAuthUrl === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = previousAuthUrl
  }
})

test("connected instrumentation writes spans into its invocation trace without replacing the app response", async () => {
  const { withDatoolCall } = await import("../src/lib/tracer/call-context")
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
    delivery: "direct",
    apiKey: "test",
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ data: {} })
    },
  })
  const root = span("external-root", "workflow")
  const child = span("external-tool", "ai.toolCall", "external-root")
  withDatoolCall(
    { connectionId: "app", callId: "call", invocationTraceId: "invocation" },
    () => {
      processor.onStart(root)
      processor.onStart(child)
    }
  )
  processor.onEnd(child)
  processor.onEnd(root)
  await processor.forceFlush()
  expect(requests.filter((r) => r.path === "/api/traces")).toHaveLength(0)
  expect(
    requests.filter((r) => r.path === "/api/traces/invocation")
  ).toHaveLength(0)
  const starts = requests.filter(
    (r) => r.path === "/api/traces/invocation/spans"
  )
  expect(starts).toHaveLength(2)
  expect(starts[1].body.parentId).toBe("external-root")
})

test("explicit OTel groups record membership once and preserve nullable versions", async () => {
  for (const rootMarker of [false, true]) {
    const events: { path: string; body: Record<string, unknown> }[] = []
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
      delivery: "direct",
      apiKey: "test-key",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)),
          path = new URL(String(url)).pathname
        if (init?.method === "POST") events.push({ path, body })
        return Response.json({ data: {} })
      },
    })
    const root = span(
      rootMarker ? "group-root-mirror" : "group-root",
      "Display title",
      undefined,
      {
        "datool.group.type": "workflow",
        "datool.group.name": "Onboarding",
        "datool.group.version": "v2",
        "datool.trace.root": rootMarker,
      }
    )
    const child = span("group-child", "Child", root.spanContext().spanId, {
      "datool.group.type": "agent",
      "datool.group.name": "Reviewer",
    })
    processor.onStart(root)
    processor.onStart(child)
    processor.onEnd(child)
    processor.onEnd(root)
    await processor.forceFlush()
    const groups = events.flatMap((event) =>
      event.body.group ? [event.body.group] : []
    )
    expect(groups).toHaveLength(2)
    expect(groups).toEqual([
      { type: "workflow", name: "Onboarding", version: "v2" },
      { type: "agent", name: "Reviewer" },
    ])
    expect(
      events.filter((event) => event.path.endsWith("/spans"))
    ).toHaveLength(rootMarker ? 1 : 2)
    await processor.shutdown()
  }
})

test("OTel membership preserves captured kinds, parents and LLM accounting", async () => {
  const events: { path: string; method: string; body: Record<string, unknown> }[] = []
  const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
    delivery: "direct",
    apiKey: "test-key",
    fetch: async (url, init) => {
      events.push({ path: new URL(String(url)).pathname, method: init!.method!, body: JSON.parse(String(init?.body)) })
      return Response.json({ data: {} })
    },
  })
  const root = span("recorded-function", "Extract", undefined, {
    "datool.span.kind": "function",
    "datool.group.type": "agent",
    "datool.group.name": "Extractor",
  })
  const model = span("recorded-llm", "Model", "recorded-function", {
    "datool.span.kind": "llm",
    "datool.group.type": "workflow",
    "datool.group.name": "Research",
    "gen_ai.usage.input_tokens": 4,
    "gen_ai.usage.output_tokens": 2,
  })
  processor.onStart(root)
  processor.onStart(model)
  processor.onEnd(model)
  processor.onEnd(root)
  await processor.shutdown()
  const children = events.filter(event => event.method === "POST" && event.path.endsWith("/spans"))
  expect(children).toHaveLength(2)
  expect(children[0].body).toMatchObject({ id: "recorded-function", kind: "function", group: { type: "agent", name: "Extractor" } })
  expect(children[1].body).toMatchObject({ id: "recorded-llm", parentId: "recorded-function", kind: "llm", group: { type: "workflow", name: "Research" } })
  const finalTrace = events.filter(event => event.method === "PATCH" && event.path.startsWith("/api/traces/")).at(-1)
  expect(finalTrace?.body.attributes).toMatchObject({ "usage.llm_calls": 1, "usage.total_tokens": 6 })
})

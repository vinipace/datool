import assert from "node:assert/strict"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { createTracer } from "../src/lib/tracer/sdk"
import { DatoolSpanProcessor } from "../src/lib/tracer/otel"

type Event = { path: string; method: string; body: Record<string, unknown> }
const events: Event[] = []
let completed = 0
const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false },
  apiKey: "fixture",
  delivery: "direct",
  shouldExport: (span) => span.instrumentationScope?.name !== "http",
  attributes: () => ({ fixture: true }),
  transform: (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("private-value", "[MASKED]")),
  onTraceEnd: () => {
    completed++
  },
  fetch: async (url, init) => {
    events.push({
      path: new URL(String(url)).pathname,
      method: init!.method!,
      body: JSON.parse(String(init!.body)),
    })
    return Response.json({ data: {} })
  },
})
const provider = new NodeTracerProvider({ spanProcessors: [processor] })
const tracer = createTracer({
  transport: "otel",
  version: "v1",
  maxInputOutputCharacters: 100,
})
beforeAll(() => provider.register())
afterAll(async () => {
  await provider.shutdown()
  trace.disable()
  context.disable()
})
const patch = (id: string) =>
  Object.assign(
    {},
    ...events
      .filter((e) => e.path.endsWith(`/${id}`) && e.method === "PATCH")
      .map((e) => e.body)
  )
const root = (name: string) =>
  events.find((e) => e.path === "/api/traces" && e.body.name === name)!.body as Record<string, unknown> & {
    id: string
    group?: { version?: string | null }
  }

test("named helpers and AI SDK spans share one OTel trace and account for object calls", async () => {
  const result = await tracer.workflow(
    { name: "workflow", input: { content: "private-value" } },
    () =>
      tracer.agent({ name: "agent" }, () =>
        tracer.span({ name: "step", kind: "task" }, async () => {
          for (const operation of ["generateObject", "streamObject"]) {
            const model = trace
              .getTracer("ai")
              .startSpan(
                `ai.${operation}.do${operation === "generateObject" ? "Generate" : "Stream"}`,
                {
                  attributes: {
                    "ai.model.provider": "openai",
                    "ai.model.id": "gpt-4.1-mini",
                    "ai.usage.inputTokens": 4,
                    "ai.usage.outputTokens": 2,
                  },
                }
              )
            model.end()
          }
          return { result: "private-value" }
        })
      )
  )
  expect(result).toEqual({ result: "private-value" })
  await processor.forceFlush()
  const workflow = root("workflow")
  expect(workflow.group).toEqual({
    type: "workflow",
    name: "workflow",
    version: "v1",
  })
  expect(patch(workflow.id)).toMatchObject({
    status: "completed",
    attributes: { "usage.llm_calls": 2, "usage.total_tokens": 12 },
  })
  const children = events.filter(
    (e) => e.path === `/api/traces/${workflow.id}/spans`
  )
  const agent = children.find((e) => e.body.kind === "agent")!.body
  const step = children.find((e) => e.body.kind === "task")!.body
  expect(step.parentId).toBe(agent.id)
  const models = children.filter((e) => e.body.kind === "llm")
  expect(models).toHaveLength(2)
  expect(models.every((e) => e.body.parentId === step.id)).toBe(true)
  expect(JSON.stringify(events)).not.toContain("private-value")
  expect(completed).toBe(1)
})

test("stream iteration retains context, forwards inputs and serializes concurrent next calls", async () => {
  let active: string | undefined
  const stream = tracer.agentStream<string, number, string>(
    { name: "stream" },
    async function* () {
      active = trace.getActiveSpan()!.spanContext().spanId
      const input = yield "first"
      await Promise.resolve()
      expect(trace.getActiveSpan()!.spanContext().spanId).toBe(active)
      yield input
      return 42
    }
  )
  expect(await stream.next()).toEqual({ done: false, value: "first" })
  const pending = [stream.next("second"), stream.next("ignored")]
  expect(await Promise.all(pending)).toEqual([
    { done: false, value: "second" },
    { done: true, value: 42 },
  ])
  await processor.forceFlush()
  expect(patch(root("stream").id)).toMatchObject({
    status: "completed",
    output: "firstsecond",
  })
})

test("return before iteration is lazy and cancellation executes cleanup in its span", async () => {
  let calls = 0
  const unused = tracer.agentStream({ name: "unused" }, async function* () {
    calls++
    yield "never"
  })
  await unused.return()
  expect(calls).toBe(0)
  let cleanup = false
  const stream = tracer.agentStream({ name: "cancel" }, async function* () {
    try {
      yield "chunk"
      yield "next"
    } finally {
      cleanup = !!trace.getActiveSpan()
    }
  })
  await stream.next()
  await stream.return()
  expect(cleanup).toBe(true)
  await processor.forceFlush()
  expect(patch(root("cancel").id).status).toBe("cancelled")
  expect(events.some((e) => e.body.name === "unused")).toBe(false)
})

test("caught iterator throws continue; unhandled errors retain identity and mark the trace", async () => {
  const stream = tracer.agentStream({ name: "recover" }, async function* () {
    try {
      yield "first"
    } catch {
      yield "recovered"
    }
  })
  await stream.next()
  expect((await stream.throw(new Error("recoverable"))).value).toBe("recovered")
  await stream.next()
  const error = new Error("private-value")
  const failed = tracer.agentStream({ name: "failed" }, async function* () {
    yield await Promise.reject(error)
  })
  await assert.rejects(failed.next(), (actual) => actual === error)
  await processor.forceFlush()
  expect(patch(root("recover").id).status).toBe("completed")
  expect(patch(root("failed").id)).toMatchObject({
    status: "errored",
    attributes: { "error.message": "[MASKED]" },
  })
})

test("separate invocations, concurrent work and delayed iteration do not reuse ended traces", async () => {
  const request = provider.getTracer("http").startSpan("request")
  await context.with(trace.setSpan(context.active(), request), async () => {
    await tracer.agent({ name: "one" }, async () => 1)
    await tracer.agent({ name: "two" }, async () => 2)
  })
  request.end()
  const delayed = await tracer.workflow({ name: "parent" }, async () =>
    tracer.agentStream({ name: "late" }, async function* () {
      yield "ok"
    })
  )
  for await (const chunk of delayed) {
    void chunk
  }
  await Promise.all(
    ["parallel-a", "parallel-b"].map((name) =>
      tracer.workflow({ name }, async () => {
        const before = trace.getActiveSpan()!.spanContext().traceId
        await new Promise((resolve) => setTimeout(resolve, 1))
        expect(trace.getActiveSpan()!.spanContext().traceId).toBe(before)
      })
    )
  )
  await processor.forceFlush()
  const roots = events.filter((e) => e.path === "/api/traces")
  expect(new Set(roots.map((e) => e.body.id)).size).toBe(roots.length)
  expect(roots.some((e) => e.body.name === "request")).toBe(false)
})

test("I/O limits, recording controls, mapping and explicit unversioned groups are respected", async () => {
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  await tracer.agent(
    {
      name: "bounded",
      input: cyclic,
      group: { type: "agent", name: "bounded", version: null },
    },
    async () => "x".repeat(101)
  )
  const start = events.length
  const stream = tracer.agentStream(
    {
      name: "private",
      input: "private-input",
      recordInputs: false,
      recordOutputs: false,
    },
    async function* () {
      yield "private-output"
    }
  )
  for await (const chunk of stream) {
    void chunk
  }
  await processor.forceFlush()
  expect(root("bounded").group?.version).toBeUndefined()
  expect(patch(root("bounded").id)).toMatchObject({
    input: {
      unavailable: true,
      reason: "non-serializable",
      valueType: "object",
    },
    output: { truncated: true, originalCharacters: 103, valueType: "string" },
  })
  expect(JSON.stringify(events.slice(start))).not.toContain("private-input")
  expect(JSON.stringify(events.slice(start))).not.toContain("private-output")
  const mapped = tracer.agentStream<string | { raw: boolean }>(
    {
      name: "mapped",
      mapOutput: (value) => (typeof value === "string" ? value : undefined),
    },
    async function* () {
      yield "answer"
      yield { raw: true }
    }
  )
  for await (const chunk of mapped) {
    void chunk
  }
  await processor.forceFlush()
  expect(patch(root("mapped").id).output).toBe("answer")
})

test("grouped generic operations retain kind and parent without passing membership to children", async () => {
  await tracer.workflow({ name: "Grouped steps" }, () =>
    tracer.span({ name: "Extract step", kind: "function", group: { type: "agent", name: "Extractor" } }, () =>
      tracer.span({ name: "LLM step", kind: "llm", group: { type: "workflow", name: "Research" } }, () =>
        tracer.span({ name: "Ungrouped tool", kind: "tool" }, () => "done")
      )
    )
  )
  await processor.forceFlush()
  const workflow = root("Grouped steps")
  const children = events.filter(event => event.path === `/api/traces/${workflow.id}/spans` && event.method === "POST")
  expect(children).toHaveLength(3)
  const [step, model, tool] = children.map(event => event.body)
  expect(step).toMatchObject({ kind: "function", group: { type: "agent", name: "Extractor" } })
  expect(model).toMatchObject({ kind: "llm", parentId: step.id, group: { type: "workflow", name: "Research" } })
  expect(tool).toMatchObject({ kind: "tool", parentId: model.id })
  expect(tool.group).toBeUndefined()
  expect((step.attributes as Record<string, unknown>)["datool.trace.root"]).toBeUndefined()
})

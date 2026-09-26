import assert from "node:assert/strict"
import { describe, expect, test } from "bun:test"
import { createDatool } from "../src/lib/tracer/client"
import { withDatoolCall } from "../src/lib/tracer/call-context"
import { defaultPrompt } from "../src/lib/tracer/prompts"
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-node"
import { context, trace } from "@opentelemetry/api"

const published = (version = 1) => ({
  ...defaultPrompt,
  id: "prompt-brand",
  slug: "brand",
  name: "Brand",
  model: `provider/model-${version}`,
  version,
  publishedVersion: version,
  messages: [{ role: "user", content: "{{name}} {{literal}} {{name}}" }],
  metadata: { nested: { value: 1 } },
})
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
function fixture(ttl = 30_000) {
  let version = 1
  let fail = false
  const requests: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    await pause()
    if (fail) return Response.json({}, { status: 404 })
    return Response.json({
      data: published(
        Number(new URL(String(url)).searchParams.get("version")) || version
      ),
    })
  }) as typeof fetch
  const client = createDatool({
    apiKey: "test-secret",
    projectId: "project",
    baseUrl: "http://datool.test",
    fetch: fetcher,
    promptCache: { latestTtlMs: ttl },
    retries: 0,
  })
  return {
    client,
    fetcher,
    requests,
    publish: () => ++version,
    fail: (value: boolean) => {
      fail = value
    },
  }
}

describe("managed prompt SDK", () => {
  test("standalone get renders named variables once, without HTML escaping or mutable cache leaks", async () => {
    const f = fixture()
    const p = await f.client.prompts.get("brand")
    expect(p.render({ name: "<A&B>", literal: "{{name}}" })).toEqual([
      { role: "user", content: "<A&B> {{name}} <A&B>" },
    ])
    expect(() => p.render({ name: "x" })).toThrow("literal")
    expect(p.settings).toEqual({
      temperature: undefined,
      maxTokens: undefined,
      output: "text",
    })
    p.messages[0].content = "mutated"
    ;(p.metadata.nested as { value: number }).value = 999
    expect(p.render({ name: "x", literal: "y" })[0].content).toBe("x y x")
    const next = await f.client.prompts.get("brand")
    expect(next.metadata.nested).toEqual({ value: 1 })
    expect(next.messages[0].content).toContain("{{name}}")
    expect(f.requests[0].init?.headers).toMatchObject({
      "x-project-id": "project",
      authorization: "Bearer test-secret",
    })
  })
  test("latest refresh is bounded, pinned versions are immutable, concurrent fetches deduplicate and failures retry", async () => {
    const f = fixture(15)
    await Promise.all(
      Array.from({ length: 10 }, () => f.client.prompts.get("brand"))
    )
    expect(f.requests).toHaveLength(1)
    f.publish()
    expect((await f.client.prompts.get("brand")).version).toBe(1)
    await pause(20)
    expect((await f.client.prompts.get("brand")).version).toBe(2)
    expect((await f.client.prompts.get("brand", { version: 1 })).version).toBe(
      1
    )
    expect(f.requests).toHaveLength(2)
    f.fail(true)
    await assert.rejects(f.client.prompts.get("missing"), /404/)
    f.fail(false)
    // Request again even though validation now rejects the different slug.
    await assert.rejects(f.client.prompts.get("missing"), /invalid published/)
    expect(f.requests).toHaveLength(4)
  })
  test("cache eviction, zero TTL, no stale-on-error fallback and in-flight override capture", async () => {
    const f = fixture(0)
    const one = await f.client.prompts.get("brand")
    f.fail(true)
    await assert.rejects(f.client.prompts.get("brand"), /404/)
    expect(one.version).toBe(1)
    f.fail(false)
    const bounded = createDatool({
      apiKey: "test",
      fetch: f.fetcher,
      promptCache: { maxEntries: 1 },
    })
    await bounded.prompts.get("brand", { version: 1 })
    await bounded.prompts.get("brand", { version: 2 })
    const count = f.requests.length
    await bounded.prompts.get("brand", { version: 1 })
    expect(f.requests.length).toBe(count + 1)
    await bounded.prompts.withScope({ brand: { version: 1 } }, async () => {
      const pending = bounded.prompts.get("brand")
      bounded.prompts.override("brand", { version: 2 })
      expect((await pending).version).toBe(1)
      expect((await bounded.prompts.get("brand")).version).toBe(2)
    })
  })
  test("caches and overrides are private to each client, project and credential", async () => {
    const f = fixture()
    const other = createDatool({
      apiKey: "another",
      projectId: "other",
      baseUrl: "http://datool.test",
      fetch: f.fetcher,
    })
    await f.client.prompts.withScope(
      { brand: { model: "override" } },
      async () => {
        expect((await f.client.prompts.get("brand")).model).toBe("override")
        expect((await other.prompts.get("brand")).model).toBe(
          "provider/model-1"
        )
      }
    )
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].init?.headers).toMatchObject({
      authorization: "Bearer another",
      "x-project-id": "other",
    })
  })
  test("simultaneous invocations, nested reset, returned objects and failures remain isolated", async () => {
    const f = fixture()
    expect(() =>
      f.client.prompts.override("brand", { model: "invalid" })
    ).toThrow("withScope")
    expect(() => f.client.prompts.reset("brand")).toThrow("withScope")
    const values = await Promise.all(
      [1, 2, 3].map((version) =>
        withDatoolCall(
          { connectionId: "a", callId: String(version) },
          async () => {
            f.client.prompts.override("brand", { version })
            await pause(4 - version)
            const p = await f.client.prompts.get("brand")
            await f.client.prompts.withScope({}, async () => {
              expect((await f.client.prompts.get("brand")).version).toBe(
                version
              )
              f.client.prompts.reset("brand")
              expect((await f.client.prompts.get("brand")).version).toBe(1)
              f.client.prompts.override("brand", { model: "nested" })
            })
            expect((await f.client.prompts.get("brand")).version).toBe(version)
            f.client.prompts.override("brand", { model: "changed" })
            expect(p.model).toBe(`provider/model-${version}`)
            return p.version
          }
        )
      )
    )
    expect(values).toEqual([1, 2, 3])
    await assert.rejects(
      f.client.prompts.withScope({ brand: { version: 2 } }, async () => {
        throw new Error("failed")
      }),
      /failed/
    )
    expect((await f.client.prompts.get("brand")).version).toBe(1)
    expect(() => f.client.prompts.reset("brand")).toThrow("withScope")
  })
  test("run snapshots pin lazy defaults, reject new publications and mismatched projects, and persist provenance", async () => {
    const writes: unknown[] = []
    const paths: string[] = []
    const client = createDatool({
      apiKey: "secret",
      projectId: "project",
      baseUrl: "http://datool.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        paths.push(path)
        if (path.endsWith("/prompts"))
          return Response.json({
            data: {
              projectId: "project",
              prompts: {
                brand: {
                  id: "prompt-brand",
                  version: 1,
                  latestVersion: 2,
                  model: "experiment",
                },
              },
              overrides: { brand: { model: "experiment" } },
            },
          })
        if (path.endsWith("/spans")) {
          writes.push(JSON.parse(String(init?.body)))
          return Response.json({ data: {} })
        }
        return Response.json({
          data: published(
            Number(new URL(String(url)).searchParams.get("version")) || 3
          ),
        })
      }) as typeof fetch,
    })
    await withDatoolCall(
      {
        connectionId: "app",
        callId: "call",
        invocationTraceId: "trace",
        promptScope: { projectId: "project", runId: "run" },
      },
      async () => {
        const p = await client.prompts.get("brand")
        expect(p.version).toBe(1)
        expect(p.model).toBe("experiment")
        client.prompts.override("brand", { version: 2, model: "temporary" })
        expect((await client.prompts.get("brand")).model).toBe("temporary")
        client.prompts.reset("brand")
        expect((await client.prompts.get("brand")).version).toBe(1)
        await assert.rejects(client.prompts.get("new"), /not published/)
        await assert.rejects(
          client.prompts.get("brand", { version: 3 }),
          /after this run/
        )
      }
    )
    expect(paths.filter((p) => p.endsWith("/prompts"))).toHaveLength(1)
    expect(writes).toHaveLength(3)
    expect(JSON.stringify(writes)).not.toContain("secret")
    expect(writes[0]).toMatchObject({
      attributes: {
        "datool.prompt.version": 1,
        "datool.prompt.model": "experiment",
      },
    })
    await assert.rejects(
      withDatoolCall(
        {
          connectionId: "app",
          callId: "other",
          promptScope: { projectId: "other", runId: "run" },
        },
        () => client.prompts.get("brand")
      ),
      /does not match/
    )
  })
  test("active OpenTelemetry spans receive prompt provenance without variable values", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    provider.register()
    const span = provider.getTracer("test").startSpan("app")
    await context.with(trace.setSpan(context.active(), span), () =>
      fixture().client.prompts.get("brand")
    )
    span.end()
    expect(exporter.getFinishedSpans()[0].events[0]).toMatchObject({
      name: "datool.prompt.resolve",
      attributes: {
        "datool.prompt.id": "prompt-brand",
        "datool.prompt.version": 1,
      },
    })
    await provider.shutdown()
  })
})

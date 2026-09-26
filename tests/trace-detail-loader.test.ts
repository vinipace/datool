import { rejects } from "node:assert/strict"
import { afterEach, expect, test } from "bun:test"
import { tracerApi } from "@/components/tracer/api"
import { createTraceDetailLoader, readAllTracePages } from "@/components/tracer/trace-detail-loader"
import type { Span, TraceDetail } from "@/src/lib/tracer/contracts"
const root: TraceDetail = { id: "trace", name: "Trace", operation: "test", status: "completed", startedAt: "2026-09-11T00:00:00Z", endedAt: "2026-09-11T00:00:01Z", durationMs: 1000, sessionId: null, attributes: {}, input: null, output: null, spans: [], scores: [] }
const span: Span = { id: "deep", traceId: "trace", parentId: "parent", kind: "task", name: "Deep", status: "completed", startedAt: root.startedAt, endedAt: root.endedAt, durationMs: 1000, attributes: { private: true }, input: { requested: true }, output: "Complete" }
const original = { ...tracerApi.traces }
afterEach(() => { Object.assign(tracerApi.traces, original) })
function countCalls<K extends "span" | "payload" | "spans" | "scores" | "overview">(key: K, implementation: typeof tracerApi.traces[K]) {
  const counter = { calls: 0 }
  tracerApi.traces[key] = ((...args: unknown[]) => {
    counter.calls++
    return (implementation as (...args: unknown[]) => unknown)(...args)
  }) as typeof implementation
  return counter
}
const signal = () => new AbortController().signal

test("first open receives root details with the tree and later polling stays lightweight", async () => {
  const requested: boolean[] = []
  countCalls("overview", async (_id, _signal, includeRootDetail) => {
    requested.push(includeRootDetail ?? false)
    return { ...root, spans: [span], ...(includeRootDetail ? { rootDetail: span } : {}) }
  })
  const selected = countCalls("span", async () => span)
  const loader = createTraceDetailLoader("trace")
  const opening = await loader.overview(signal())
  expect(loader.peek(opening, span)).toBe(span)
  expect(await loader.span(span, opening, signal())).toBe(span)
  expect(selected.calls).toBe(0)
  const refreshed = await loader.overview(signal())
  expect(loader.peek(refreshed, span)).toBe(span)
  expect(requested).toEqual([true, false])
  expect(refreshed.rootDetail).toBeUndefined()
  expect(loader.peek(refreshed, { ...span, status: "errored" })).toBeUndefined()
  expect(createTraceDetailLoader("another-trace").peek(root, span)).toBeUndefined()
})

test("synthetic trace roots render immediately and failed or aborted openings retry the full initial response", async () => {
  const requested: boolean[] = []
  const overview = countCalls("overview", async (_id, _signal, includeRootDetail) => {
    requested.push(includeRootDetail ?? false)
    if (overview.calls === 1) throw new Error("temporary failure")
    return { ...root, rootDetail: root }
  })
  const payload = countCalls("payload", async () => root)
  const loader = createTraceDetailLoader("trace")
  await rejects(loader.overview(signal()), /temporary failure/)
  const aborted = new AbortController()
  aborted.abort()
  await rejects(loader.overview(aborted.signal))
  expect(loader.peek(root)).toBeUndefined()
  const opening = await loader.overview(signal())
  expect(loader.peek(opening)).toBe(root)
  expect(await loader.payload(opening, signal())).toBe(root)
  expect(payload.calls).toBe(0)
  expect(requested).toEqual([true, true, true])
})

test("only selected detail is fetched, reused, and refreshed while live or changing status", async () => {
  const selected = countCalls("span", async () => span)
  const pages = countCalls("spans", original.spans)
  const loader = createTraceDetailLoader("trace")
  expect(selected.calls).toBe(0)
  expect(await loader.span(span, root, signal())).toEqual(span)
  await loader.span(span, root, signal())
  expect(selected.calls).toBe(1)
  expect(pages.calls).toBe(0)
  await loader.span(span, { ...root, status: "running" }, signal())
  await loader.span({ ...span, status: "errored" }, root, signal())
  expect(selected.calls).toBe(3)
  await createTraceDetailLoader("trace").span(span, root, signal())
  expect(selected.calls).toBe(4)
})

test("failures and aborted responses never poison the detail cache", async () => {
  const selected = countCalls("span", async () => { if (selected.calls === 1) throw new Error("temporary failure"); return span })
  const loader = createTraceDetailLoader("trace")
  await rejects(loader.span(span, root, signal()), /temporary failure/)
  const aborted = new AbortController()
  aborted.abort()
  await rejects(loader.span(span, root, aborted.signal))
  await loader.span(span, root, signal())
  expect(selected.calls).toBe(3)
})

test("custom views and root raw JSON hydrate every span and score page only on demand", async () => {
  const payload = countCalls("payload", async () => root)
  const pages = countCalls("spans", async (_id, options) => ({
    items: Array.from({ length: options?.cursor ? 5 : 200 }, (_, i) => ({ ...span, id: `${options?.cursor ?? "first"}-${i}` })),
    nextCursor: options?.cursor ? null : "next",
  }))
  const scores = countCalls("scores", async () => ({ items: [], nextCursor: null }))
  const loader = createTraceDetailLoader("trace")
  expect(pages.calls).toBe(0)
  const full = await loader.full(root, signal())
  expect(full.spans).toHaveLength(205)
  expect(full.spans[204].output).toBe("Complete")
  expect(full.nextSpanCursor).toBeNull()
  expect(payload.calls).toBe(1)
  expect(scores.calls).toBe(1)
  expect(pages.calls).toBe(2)
  const selected = countCalls("span", original.span)
  await loader.span(full.spans[204], root, signal())
  expect(selected.calls).toBe(0)
})

test("page errors do not return partial evidence and repeated cursors stop", async () => {
  let calls = 0
  await rejects(readAllTracePages(async () => {
    if (calls++) throw new Error("page failed")
    return { items: [span], nextCursor: "next" }
  }, signal()), /page failed/)
  await rejects(readAllTracePages(async () => ({ items: [span], nextCursor: "same" }), signal()), /did not advance/)
})

test("snapshots stay offline and preserve complete frozen payloads", async () => {
  const selected = countCalls("span", original.span)
  const payload = countCalls("payload", original.payload)
  const snapshot = { ...root, spans: [span] }
  const loader = createTraceDetailLoader("trace", snapshot)
  expect(await loader.full(snapshot, signal())).toBe(snapshot)
  expect(await loader.payload(snapshot, signal())).toBe(snapshot)
  expect(await loader.span(span, snapshot, signal())).toBe(span)
  expect(selected.calls).toBe(0)
  expect(payload.calls).toBe(0)
})

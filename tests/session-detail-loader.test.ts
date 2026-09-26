import { afterEach, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { tracerApi } from "@/components/tracer/api"
import { createSessionConversationLoader, loadSessionOverview } from "@/components/tracer/session-detail-loader"
import { storybookSessionDetail, traceOverview, traceRow } from "../.storybook/scenarios/traces/fixtures"

const originalTraces = { ...tracerApi.traces }
const originalSession = tracerApi.sessions.get
afterEach(() => {
  Object.assign(tracerApi.traces, originalTraces)
  tracerApi.sessions.get = originalSession
})

test("loads every session page, orders traces chronologically and bounds summary requests", async () => {
  const signal = new AbortController().signal
  const cursors: (string | undefined)[] = []
  tracerApi.sessions.get = async (id, received) => {
    expect(id).toBe("session")
    expect(received).toBe(signal)
    return storybookSessionDetail
  }
  tracerApi.traces.list = async options => {
    expect(options?.sessionId).toBe("session")
    expect(options?.signal).toBe(signal)
    cursors.push(options?.cursor)
    return { items: Array.from({ length: options?.cursor ? 1 : 200 }, (_, i) => ({ ...traceRow, id: String(options?.cursor ? 200 : i) })), nextCursor: options?.cursor ? null : "next" }
  }
  let active = 0
  let peak = 0
  tracerApi.traces.overview = async (id, received) => {
    expect(received).toBe(signal)
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    return { ...traceOverview, id, startedAt: new Date(1_000_000 - Number(id) * 1000).toISOString() }
  }
  tracerApi.traces.get = async () => { throw new Error("Full payloads must remain lazy") }
  tracerApi.traces.scores = async (id, options) => ({
    items: [{ id: `${id}-${options?.cursor ?? "first"}`, name: "Quality", evaluatorId: null, evaluatorName: null, evalResultId: null, evalRunId: null, score: 1, status: "ok" }],
    nextCursor: options?.cursor ? null : "more",
  })
  const result = await loadSessionOverview("session", signal)
  expect(cursors).toEqual([undefined, "next"])
  expect(result.traces).toHaveLength(201)
  expect(result.traces[0].id).toBe("200")
  expect(result.traces.at(-1)?.id).toBe("0")
  expect(peak).toBeLessThanOrEqual(4)
  expect(result.traces.every(trace => trace.scores.length === 2)).toBe(true)
})

test("incomplete session loads fail visibly and cancelled loads stop", async () => {
  tracerApi.sessions.get = async () => storybookSessionDetail
  tracerApi.traces.list = async () => ({ items: [traceRow], nextCursor: null })
  tracerApi.traces.overview = async () => { throw new Error("Cannot load child trace") }
  tracerApi.traces.scores = async () => ({ items: [], nextCursor: null })
  await rejects(loadSessionOverview("session", new AbortController().signal), /Cannot load child trace/)
  const controller = new AbortController()
  controller.abort()
  await rejects(loadSessionOverview("session", controller.signal))
})

test("conversation reads every span page, caches completed traces and refreshes running traces", async () => {
  const signal = new AbortController().signal
  const load = createSessionConversationLoader()
  let requests = 0
  const cursors: (string | undefined)[] = []
  tracerApi.traces.payload = async (id, received) => {
    expect(received).toBe(signal)
    requests++
    return { ...traceRow, id, input: "Hello", output: "Hi" }
  }
  tracerApi.traces.spans = async (_id, options) => {
    expect(options?.signal).toBe(signal)
    cursors.push(options?.cursor)
    return { items: [], nextCursor: options?.cursor ? null : "last" }
  }
  expect((await load([traceOverview], signal)).map(message => message.content)).toEqual(["Hello", "Hi"])
  await load([traceOverview], signal)
  expect(requests).toBe(1)
  expect(cursors).toEqual([undefined, "last"])
  await load([{ ...traceOverview, status: "running" }], signal)
  await load([{ ...traceOverview, status: "running" }], signal)
  expect(requests).toBe(3)
})

test("conversation does not return partial evidence when a later page fails", async () => {
  tracerApi.traces.payload = async () => ({ ...traceRow, input: "Hello", output: "Hi" })
  tracerApi.traces.spans = async (_id, options) => {
    if (options?.cursor) throw new Error("Conversation page unavailable")
    return { items: [], nextCursor: "last" }
  }
  const load = createSessionConversationLoader()
  await rejects(load([traceOverview], new AbortController().signal), /Conversation page unavailable/)
  const controller = new AbortController()
  controller.abort()
  await rejects(load([traceOverview], controller.signal))
})

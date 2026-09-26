import { afterEach, beforeEach, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { tracerApi } from "@/components/tracer/api"
import { loadPlaygroundRun } from "@/components/tracer/playground-run-data"
import type { TraceDetail } from "@/src/lib/tracer/contracts"

const original = { ...tracerApi.traces }
beforeEach(() => { tracerApi.traces.scores = async () => ({ items: [], nextCursor: null }) })
afterEach(() => {
  Object.assign(tracerApi.traces, original)
})
const invocation: TraceDetail = {
  id: "invocation",
  name: "App",
  operation: "app.invoke",
  input: {},
  output: {},
  status: "completed",
  startedAt: "2026-09-16T00:00:00Z",
  endedAt: "2026-09-16T00:00:01Z",
  durationMs: 1000,
  sessionId: null,
  attributes: { "datool.call.id": 'call"id', "datool.connection.id": "app" },
  spans: [],
  scores: [],
}
const signal = () => new AbortController().signal

test("late scorer results load from every score page and appear in the trace inspector", async () => {
  tracerApi.traces.payload = async () => invocation
  tracerApi.traces.list = async () => ({ items: [], nextCursor: null })
  tracerApi.traces.overview = async () => ({ ...invocation, scores: [] })
  expect((await loadPlaygroundRun(invocation.id, "app", signal())).traces[0].scores).toEqual([])
  const score = { id: "score-1", evaluatorId: "scorer", evaluatorName: "Image quality", name: "Image quality", score: 1, evalResultId: "result-1", evalRunId: "run-1", status: "ok" as const }
  tracerApi.traces.scores = async (_, options) => options?.cursor ? ({ items: [{ ...score, id: "score-2" }], nextCursor: null }) : ({ items: [score], nextCursor: "next" })
  expect((await loadPlaygroundRun(invocation.id, "app", signal())).traces[0].scores.map(score => score.id)).toEqual(["score-1", "score-2"])
  tracerApi.traces.scores = async () => { throw new Error("Scores unavailable") }
  await rejects(loadPlaygroundRun(invocation.id, "app", signal()), /Scores unavailable/)
})

test("loads every correlated trace page, deduplicates invocation and fetches each full hierarchy", async () => {
  const requested: string[] = []
  const cursors: Array<string | undefined> = []
  tracerApi.traces.payload = async () => invocation
  tracerApi.traces.list = async (options) => {
    expect(options?.filter).toBe(
      `metadata."datool.call.id" = ${JSON.stringify('call"id')}`
    )
    cursors.push(options?.cursor)
    return options?.cursor
      ? { items: [{ ...invocation, id: "last" }], nextCursor: null }
      : {
          items: [
            invocation,
            ...Array.from({ length: 201 }, (_, index) => ({
              ...invocation,
              id: String(index),
            })),
          ],
          nextCursor: "page2",
        }
  }
  tracerApi.traces.overview = async (id) => {
    requested.push(id)
    return { ...invocation, id }
  }
  const result = await loadPlaygroundRun(invocation.id, "app", signal())
  expect(cursors).toEqual([undefined, "page2"])
  expect(result.traces).toHaveLength(203)
  expect(requested).toHaveLength(203)
  expect(result.traces[0].id).toBe(invocation.id)
  expect(result.traces.at(-1)?.id).toBe("last")
})

test("rejects a run from another app before querying its traces", async () => {
  tracerApi.traces.payload = async () => invocation
  tracerApi.traces.list = async () => {
    throw new Error("must not query")
  }
  await rejects(
    loadPlaygroundRun(invocation.id, "other-app", signal()),
    /does not belong/
  )
})

test("late correlated traces appear on refresh and an incomplete read fails explicitly", async () => {
  tracerApi.traces.payload = async () => invocation
  let late = false
  tracerApi.traces.list = async () => ({
    items: late ? [{ ...invocation, id: "late" }] : [],
    nextCursor: null,
  })
  tracerApi.traces.overview = async (id) => ({ ...invocation, id })
  expect(
    (await loadPlaygroundRun(invocation.id, "app", signal())).traces
  ).toHaveLength(1)
  late = true
  expect(
    (await loadPlaygroundRun(invocation.id, "app", signal())).traces
  ).toHaveLength(2)
  tracerApi.traces.overview = async (id) => {
    if (id === "late") throw new Error("Read failed")
    return invocation
  }
  await rejects(
    loadPlaygroundRun(invocation.id, "app", signal()),
    /Read failed/
  )
})

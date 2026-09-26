import { describe, expect, test } from "bun:test"
import { toViewerTrace, toViewerRun } from "@/components/tracer/trace-viewer-data"
import type { Span, TraceDetail } from "@/src/lib/tracer/contracts"

const startedAt = "2026-09-11T00:00:00.000Z"
const start = Date.parse(startedAt)
const baseSpan: Span = {
  id: "root",
  traceId: "trace",
  name: "Run workflow",
  kind: "workflow",
  parentId: null,
  startedAt,
  endedAt: null,
  durationMs: 1250,
  status: "completed",
  attributes: { model: "test" },
  input: { query: "Hello" },
  output: "Done",
}
function trace(spans: Span[]): TraceDetail {
  return {
    id: "trace",
    name: "Run workflow",
    operation: "workflow",
    sessionId: null,
    startedAt,
    endedAt: null,
    durationMs: 1250,
    status: "completed",
    attributes: {},
    input: null,
    output: null,
    scores: [],
    spans,
  }
}

describe("inspector trace viewer adapter", () => {
  test("keeps captured duration when a completed span has no end timestamp", () => {
    const viewer = toViewerTrace(trace([baseSpan]), start + 60_000)
    expect(viewer.spans[0].duration).toEqual([1, 250_000_000])
    expect(viewer.spans[0].endTime).toEqual([start / 1000 + 1, 250_000_000])
    expect(viewer.spans[0].isRunning).toBe(false)
  })

  test("preserves hierarchy, input/output, resource kinds and error status", () => {
    const viewer = toViewerTrace(
      trace([
        baseSpan,
        {
          ...baseSpan,
          id: "child",
          parentId: "root",
          kind: "llm",
          status: "errored",
        },
      ])
    )
    expect(viewer.rootSpanId).toBe("root")
    expect(viewer.spans[1].parentSpanId).toBe("root")
    expect(viewer.spans[1].status.code).toBe(2)
    expect(viewer.spans[1].resource).toBe("llm")
    expect(viewer.spans[0].attributes).toEqual({
      model: "test",
      "datool.span.input": { query: "Hello" },
      "datool.span.output": "Done",
    })
  })

  test("grows running spans without inventing elapsed time for untimed completed spans", () => {
    const viewer = toViewerTrace(
      trace([
        { ...baseSpan, id: "running", durationMs: null, status: "running" },
        { ...baseSpan, id: "unknown", durationMs: null },
        { ...baseSpan, id: "invalid", startedAt: "invalid" },
      ]),
      start + 2500
    )
    expect(viewer.spans.map((span) => span.spanId)).toEqual(["running"])
    expect(viewer.spans[0].duration).toEqual([2, 500_000_000])
    expect(viewer.spans[0].isRunning).toBe(true)
    expect(viewer.spans[0].status.code).toBe(0)
  })

  test("uses the captured end timestamp when supplied", () => {
    const viewer = toViewerTrace(
      trace([{ ...baseSpan, endedAt: "2026-09-11T00:00:02.000Z" }])
    )
    expect(viewer.spans[0].duration).toEqual([2, 0])
  })
})


test("run timeline includes independent invocation roots and disambiguates repeated span IDs", () => {
  const one = { ...trace([baseSpan]), group: { type: "workflow" as const, name: "Images" } }
  const two = { ...trace([{ ...baseSpan, traceId: "second" }, { ...baseSpan, id: "score", kind: "score" as const, durationMs: 90_000 }]), id: "second" }
  const run = toViewerRun([one, two], start + 60_000)
  expect(run.trace.spans).toHaveLength(4)
  expect(new Set(run.trace.spans.map(span => span.spanId)).size).toBe(4)
  expect(run.trace.spans.filter(span => !span.parentSpanId)).toHaveLength(2)
  expect(run.targets.get(run.trace.spans[3].spanId)).toEqual({ traceId: "second", spanId: "root" })
  expect(run.targets.get(run.trace.spans[0].spanId)).toEqual({ traceId: "trace", spanId: null })
  expect(run.trace.spans[0].duration).toEqual([1, 250_000_000])
  expect(toViewerRun([trace([])]).trace.spans).toHaveLength(1)
})

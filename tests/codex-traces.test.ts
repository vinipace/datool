import { describe, expect, test } from "bun:test"
import fixture from "./fixtures/codex/canary.json"
import { decodeOtlp, mergeTelemetry } from "../src/lib/codex-traces/otlp"
import { normalizeCodexTurn } from "../src/lib/codex-traces/normalize"
import { parseCodexSnapshot } from "../src/server/codex-traces/persist"
import type { CodexThread, Telemetry } from "../src/lib/codex-traces/types"

const thread = fixture.thread as CodexThread
const capturedAt = "2026-09-17T06:25:00.000Z"
function telemetry(): Telemetry {
  return mergeTelemetry([
    decodeOtlp("traces", fixture.traces),
    decodeOtlp("logs", fixture.logs),
  ])
}
const snapshot = (data = telemetry()) =>
  normalizeCodexTurn(thread, thread.turns[0], data, capturedAt)

describe("real Codex capture normalization", () => {
  test("turn usage matches Codex exactly, excluding warmup and inclusive wrapper totals", () => {
    const value = snapshot()
    expect(value.trace.attributes?.["usage.input_tokens"]).toBe(34405)
    expect(value.trace.attributes?.["usage.output_tokens"]).toBe(53)
    expect(value.trace.attributes?.["usage.total_tokens"]).toBe(34458)
    expect(value.trace.attributes?.["usage.cache_read_tokens"]).toBe(17024)
    expect(value.trace.attributes?.["codex.usage.reconciliation"]).toBe(
      "matched"
    )
    expect(value.trace.spans.filter((s) => s.kind === "llm")).toHaveLength(2)
    expect(value.trace.spans.filter((s) => s.kind === "tool")).toHaveLength(2)
    expect(value.trace.output).toBe("datool-codex-canary-42")
    expect(value.trace.status).toBe("completed")
    expect(parseCodexSnapshot(value)).toEqual(value)
  })

  test("retains model context, tool arguments, full stdout, exit code and final response", () => {
    const value = snapshot()
    const tool = value.trace.spans.find(
      (s) => s.name === "functions.exec_command"
    )!
    expect(tool.input).toEqual({ cmd: 'printf "datool-codex-canary-42\\n"' })
    expect(tool.output).toEqual({
      stdout: "datool-codex-canary-42\n",
      exitCode: 0,
    })
    expect(tool.attributes?.["codex.output.truncated"]).toBe(false)
    const models = value.trace.spans.filter((s) => s.kind === "llm")
    expect(JSON.stringify(models[0].input)).toContain(
      "This is a local Datool telemetry canary"
    )
    expect(JSON.stringify(models[0].output)).toContain("custom_tool_call")
    expect(JSON.stringify(models[1].input)).toContain("custom_tool_call_output")
    expect(JSON.stringify(models[1].output)).toContain("datool-codex-canary-42")
    expect(models[1].attributes?.["ttft.ms"]).toBe(914)
    expect(models[1].attributes?.["codex.input.coverage"]).toBe(
      "recorded_context_not_wire_request"
    )
  })

  test("uses response completion for model latency and keeps tools inside step timing", () => {
    const spans = snapshot().trace.spans
    const first = spans.find((s) => s.kind === "function")!
    const model = spans.find((s) => s.kind === "llm")!
    expect(Date.parse(model.endedAt!)).toBeLessThan(Date.parse(first.endedAt!))
    expect(model.parentId).toBe(first.id)
    expect(spans.find((s) => s.name === "functions.exec")?.parentId).toBe(
      first.id
    )
    expect(
      spans.find((s) => s.name === "functions.exec_command")?.attributes?.[
        "codex.parent.source"
      ]
    ).toBe("unique_sampling_interval")
  })

  test("deduplicates retries and reconstructs children delivered before parents", () => {
    const data = telemetry()
    const reversed = {
      spans: [...data.spans].reverse(),
      logs: [...data.logs].reverse(),
    }
    expect(snapshot(mergeTelemetry([reversed, data, reversed]))).toEqual(
      snapshot()
    )
  })

  test("missing sampling data is partial, never passing zero or an invented cost", () => {
    const data = telemetry()
    data.spans = data.spans.filter(
      (s) => s.attributes["gen_ai.usage.input_tokens"] === undefined
    )
    const value = snapshot(data)
    expect(value.trace.attributes?.["usage.total_tokens"]).toBeUndefined()
    expect(value.trace.attributes?.["usage.status"]).toBe("partial")
    expect(value.trace.attributes?.["cost.usd"]).toBeUndefined()
    expect(value.trace.attributes?.["codex.usage.reconciliation"]).toBe(
      "mismatch"
    )
  })

  test("tool failures are retained even if Codex recovers and completes the turn", () => {
    const data = telemetry()
    const log = data.logs.find((l) => l.name === "codex.tool_result")!
    log.attributes.success = false
    const value = snapshot(data)
    expect(
      value.trace.spans.some((s) => s.kind === "tool" && s.status === "errored")
    ).toBe(true)
    expect(value.trace.status).toBe("completed")
    const source = structuredClone(thread)
    const command = source.turns[0].items.find(
      (item) => item.type === "commandExecution"
    )!
    command.exitCode = 7
    const failed = normalizeCodexTurn(
      source,
      source.turns[0],
      data,
      capturedAt
    ).trace.spans.find((s) => s.attributes?.["codex.call_id"] === command.id)!
    expect(failed.status).toBe("errored")
    expect(failed.attributes?.["error.message"]).toBe(
      "Command exited with code 7"
    )
  })

  test("does not import tool events from the preceding turn in the same conversation", () => {
    const data = telemetry()
    const earlier = structuredClone(
      data.logs.find((l) => l.name === "codex.tool_result")!
    )
    earlier.id = "earlier"
    earlier.attributes.call_id = "previous-turn-tool"
    earlier.at =
      data.spans.find((s) => s.name === "session_task.turn")!.start - 100
    data.logs.push(earlier)
    expect(
      snapshot(data).trace.spans.filter((s) => s.kind === "tool")
    ).toHaveLength(2)
  })

  test("history-only imports expose missing timing and usage instead of fabricating them", () => {
    const value = snapshot({ spans: [], logs: [] })
    expect(value.trace.attributes?.["codex.telemetry.coverage"]).toBe(
      "history_only"
    )
    expect(value.trace.attributes?.["usage.status"]).toBe("missing")
    const tool = value.trace.spans.find((s) => s.kind === "tool")!
    expect(tool.endedAt).toBeUndefined()
    expect(tool.attributes?.["codex.timing.source"]).toBe("unavailable")
    expect(tool.id).toBe(
      snapshot().trace.spans.find(
        (s) => s.attributes?.["codex.item"] && s.kind === "tool"
      )!.id
    )
  })

  test("retains exported reasoning summaries while omitting encrypted and raw reasoning", () => {
    const source = structuredClone(thread)
    const item = {
      id: "reasoning-test",
      type: "reasoning",
      summary: ["Public summary"],
      content: ["Raw reasoning"],
      encrypted_content: "opaque",
    }
    source.turns[0].items.push(item)
    source.recordedItems!.push({
      at:
        telemetry().spans.find((s) => s.name === "session_task.turn")!.start +
        1,
      item,
    })
    const value = JSON.stringify(
      normalizeCodexTurn(source, source.turns[0], telemetry(), capturedAt)
    )
    expect(value).toContain("Public summary")
    expect(value).not.toContain("Raw reasoning")
    expect(value).not.toContain("encrypted_content")
  })

  test("rejects cyclic graphs, duplicate IDs and end-before-start snapshots", () => {
    const value = snapshot()
    value.trace.spans[0].parentId = value.trace.spans[0].id
    expect(() => parseCodexSnapshot(value)).toThrow("cyclic")
    const duplicate = snapshot()
    duplicate.trace.spans.push(duplicate.trace.spans[0])
    expect(() => parseCodexSnapshot(duplicate)).toThrow("unique")
    const backwards = snapshot()
    backwards.trace.endedAt = "2000-01-01T00:00:00.000Z"
    expect(() => parseCodexSnapshot(backwards)).toThrow("before")
  })

  test("rejects malformed OTLP rather than acknowledging discarded traces", () => {
    expect(() => decodeOtlp("traces", { foo: [] })).toThrow()
    const invalid = structuredClone(fixture.traces)
    invalid.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano = "1"
    expect(() => decodeOtlp("traces", invalid)).toThrow("interval")
  })
})

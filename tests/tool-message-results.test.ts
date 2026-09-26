import { expect, test } from "bun:test"
import { groupToolResults, normaliseChatMessages, toolResultFailed, type InspectorMessage } from "@/src/lib/tracer/value-messages"

const call = (id: string) => ({ id, name: "terminal", arguments: "{}" })
const assistant = (...ids: string[]): InspectorMessage => ({ role: "assistant", content: null, toolCalls: ids.map(call) })
const result = (id: string, content: unknown): InspectorMessage => ({ role: "tool", content, toolCallId: id, toolCalls: [] })

test("parallel results join their exact call IDs regardless of completion order", () => {
  const messages = [assistant("one", "two"), result("two", "second"), result("one", "first")]
  const before = JSON.stringify(messages)
  const transcript = groupToolResults(messages)
  expect(transcript).toHaveLength(1)
  expect(transcript[0].toolResults.map(results => results.map(message => message.content))).toEqual([["first"], ["second"]])
  expect(JSON.stringify(messages)).toBe(before)
})

test("unmatched or missing IDs stay visible and reused IDs bind to the latest preceding call", () => {
  const orphan = result("missing", "unmatched")
  const noId = { role: "tool", content: "unlinked", toolCalls: [] }
  const messages = [orphan, result("one", "before call"), assistant("one"), result("one", "first"), assistant("one"), result("one", "second"), noId]
  const transcript = groupToolResults(messages)
  expect(transcript.map(item => item.message)).toEqual([orphan, messages[1], messages[2], messages[4], noId])
  expect(transcript[2].toolResults[0][0].content).toBe("first")
  expect(transcript[3].toolResults[0][0].content).toBe("second")
})

test("normalization preserves result IDs and explicit failure without changing captured data", () => {
  const captures = [{ role: "tool", toolCallId: "one", isError: true, content: "Unavailable" }]
  const before = JSON.stringify(captures)
  expect(normaliseChatMessages(captures)).toEqual([{ role: "tool", toolCallId: "one", isError: true, content: "Unavailable", toolCalls: [] }])
  expect(JSON.stringify(captures)).toBe(before)
})

test("tool output status recognizes failures and keeps empty, plain and truncated results readable", () => {
  for (const value of [{ exit_code: 7 }, { exitCode: 1 }, { error: "Unavailable" }, { success: false }, { isError: true }, { is_error: true }, { status: "errored" }]) {
    expect(toolResultFailed(result("one", value))).toBe(true)
    expect(toolResultFailed(result("one", JSON.stringify(value)))).toBe(true)
  }
  for (const value of [{ output: "42", exit_code: 0, error: null }, { error: false }, { error: "" }, "42", "", null, '{"output":"truncated']) {
    expect(toolResultFailed(result("one", value))).toBe(false)
  }
  expect(toolResultFailed({ ...result("one", "failed"), isError: true })).toBe(true)
})

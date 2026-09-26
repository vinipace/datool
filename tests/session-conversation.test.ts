import { expect, test } from "bun:test"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import { sessionConversation, type ConversationTrace } from "@/src/lib/tracer/session-conversation"
import { traceRow, traceSpans } from "../.storybook/scenarios/traces/fixtures"

const user = (content: string) => ({ role: "user", content })
const assistant = (content: string) => ({ role: "assistant", content })
const response = (message: JsonValue) => ({ model: "demo", finish_reason: "stop", assistant_message: message })
function turn(id: string, messages: JsonValue[], output: JsonValue): ConversationTrace {
  return { ...traceRow, id, startedAt: id, input: null, output: null,
    spans: [{ ...traceSpans[1], id, input: { method: "POST", body: { model: "demo", messages } }, output: response(output) }],
  }
}

test("session conversation orders turns and removes replayed history without mutating captures", () => {
  const history = [user("say hi"), assistant("Hi!"), user("say hi"), assistant("Hi!")]
  const traces = [turn("2", [{ role: "system", content: "changed instructions" }, ...history.slice(0, 3)], history[3]),
    turn("1", [{ role: "system", content: "instructions" }, history[0]], history[1])]
  const before = JSON.stringify(traces)
  expect(sessionConversation(traces).map(({ role, content }) => ({ role, content }))).toEqual(history)
  expect(JSON.stringify(traces)).toBe(before)
})

test("preserves tool calls and results across model iterations only once", () => {
  const call = { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "terminal", arguments: '{"command":"sum"}' } }] }
  const result = { role: "tool", tool_call_id: "call-1", content: "42" }
  const trace = turn("1", [user("Add the numbers")], call)
  trace.spans.push({ ...trace.spans[0], id: "second-model", startedAt: "later", input: { messages: [user("Add the numbers"), call, result] }, output: response(assistant("The sum is 42")) })
  const conversation = sessionConversation([trace])
  expect(conversation.map(message => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
  expect(conversation[1].toolCalls[0].name).toBe("terminal")
  expect(conversation[2].content).toBe("42")
})

test("matches Hermes null-content tool responses with empty-string request history", () => {
  const request = user("Read numbers.txt and write their sum to demo-answer.txt")
  const toolCall = { id: "call-1", name: "terminal", arguments: '{"command":"sum"}', provider_data: null }
  const output = { role: "assistant", content: null, tool_calls: [toolCall] }
  const replay = { role: "assistant", content: "", tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] }
  const result = { role: "tool", tool_call_id: toolCall.id, content: '{"output":"42","exit_code":0}' }
  const trace = turn("1", [request], output)
  trace.spans.push({ ...trace.spans[0], id: "second-model", startedAt: "later", input: { messages: [request, replay, result] }, output: response(assistant("The sum is 42")) })
  const before = JSON.stringify(trace)
  const conversation = sessionConversation([trace])
  expect(conversation.map(message => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
  expect(conversation[1].content).toBeNull()
  expect(conversation[1].toolCalls).toEqual([{ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }])
  expect(conversation[2].content).toBe(result.content)
  expect(conversation[3].content).toBe("The sum is 42")
  expect(JSON.stringify(trace)).toBe(before)
})

test("plain trace turns and interrupted repeated requests remain distinct", () => {
  const trace = { ...traceRow, input: "again", output: null, spans: [] }
  expect(sessionConversation([{ ...trace, id: "1" }, { ...trace, id: "2", output: "Done" }]).map(message => message.content)).toEqual(["again", "again", "Done"])
  const one = turn("1", [user("again")], { role: "assistant" })
  const two = turn("2", [user("again")], assistant("Done"))
  expect(sessionConversation([one, two]).map(message => message.content)).toEqual(["again", "again", "Done"])
})

test("root text fills missing model input or final output, and unknown data stays out of chat", () => {
  const trace = turn("1", [], { role: "assistant" })
  trace.input = "Hello"
  trace.output = "Hi"
  expect(sessionConversation([trace]).map(message => message.content)).toEqual(["Hello", "Hi"])
  expect(sessionConversation([{ ...trace, input: { capture: "disabled" }, output: { result: "not a chat" }, spans: [] }])).toEqual([])
  expect(sessionConversation([])).toEqual([])
})

test("agent state output uses the shared input-prefix normalization", () => {
  const input = { messages: [user("Hello")] }
  const output = { messages: [user("Hello"), assistant("Hi")] }
  const trace = { ...traceRow, input, output, spans: [] }
  expect(sessionConversation([trace]).map(message => message.content)).toEqual(["Hello", "Hi"])
})

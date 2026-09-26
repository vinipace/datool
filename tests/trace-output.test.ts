import { expect, test } from "bun:test"
import { normaliseChatMessages, normaliseOutputMessages } from "../components/tracer/trace-inspector-data"

test("adapter output shows assistant text and separate tool calls without mutating raw data", () => {
  const value = { text: "São Paulo: 24°C and sunny.", toolCalls: [{ toolCallId: "call-1", toolName: "getWeather", input: { city: "São Paulo" } }] }
  const before = JSON.stringify(value)
  expect(normaliseOutputMessages(value)).toEqual([{ role: "assistant", content: value.text, toolCalls: [{ id: "call-1", name: "getWeather", arguments: { city: "São Paulo" } }] }])
  expect(JSON.stringify(value)).toBe(before)
  expect(normaliseChatMessages(value)).toBeNull()
})

test("raw strings retain the JSON fallback while adapter envelopes remain messages", () => {
  for (const value of ["Hello", "", "ed3f5ce2-49d9-4377-b7ca-75a40eafaf53", JSON.stringify([{ role: "assistant", content: "Serialized data" }])]) {
    expect(normaliseOutputMessages(value)).toBeNull()
  }
  expect(normaliseOutputMessages({ text: "", toolCalls: [{ toolName: "lookup", input: {} }] })?.[0].toolCalls.length).toBe(1)
  expect(normaliseOutputMessages({ text: "Done", toolCalls: [] })?.[0].content).toBe("Done")
})

test("single LangChain message batches render without merging independent batches", () => {
  const messages = [
    { role: "system", content: "Use the weather tool." },
    { role: "user", content: "Weather?" },
  ]
  const result = [{ role: "assistant", content: "", tool_calls: [{ name: "weather", args: { city: "São Paulo" }, id: "call-1" }] }]
  expect(normaliseChatMessages([messages])).toEqual(normaliseChatMessages(messages))
  expect(normaliseOutputMessages([result])).toEqual(normaliseOutputMessages(result))
  expect(normaliseOutputMessages({ messages: [messages] }, { messages: [messages] })).toEqual(normaliseChatMessages(messages))
  for (const value of [[messages, messages], [[messages]], [[]], [["unstructured"]], [[messages[0], null]]]) {
    expect(normaliseChatMessages(value)).toBeNull()
    expect(normaliseOutputMessages(value)).toBeNull()
  }
})

test("structured output and malformed calls retain the JSON fallback", () => {
  for (const value of [null, { text: "Application field" }, { text: "Result", toolCalls: [], extra: 1 }, { text: "Result", toolCalls: [{}] }]) {
    expect(normaliseOutputMessages(value)).toBeNull()
  }
  const messages = [{ role: "assistant", content: "Hello" }]
  expect(normaliseOutputMessages(messages)).toEqual(normaliseChatMessages(messages))
})

test("agent output omits only an exact input prefix and retains new repeated messages", () => {
  const input = { messages: [
    { role: "user", content: "Weather?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "weather", args: { city: "São Paulo" } }] },
    { role: "tool", content: "Sunny", tool_call_id: "call-1" },
  ] }
  const added = [{ role: "assistant", content: "Sunny today." }, { role: "user", content: "Weather?" }]
  const output = { messages: [
    { content: "Weather?", role: "user" },
    ...input.messages.slice(1), ...added,
  ], todos: [{ status: "completed" }] }
  const before = JSON.stringify({ input, output })
  expect(normaliseOutputMessages(output, input)).toEqual(normaliseChatMessages(added))
  expect(normaliseOutputMessages(output)).toHaveLength(5)
  expect(JSON.stringify({ input, output })).toBe(before)
  expect(normaliseOutputMessages(input, input)).toEqual([])
})

test("output projection retains changed, partial and unrelated conversation history", () => {
  const original = { role: "tool", content: "Sunny", tool_call_id: "call-1" }
  const input = { messages: [original] }
  for (const changed of [
    { ...original, tool_call_id: "call-2" },
    { ...original, content: "Rain" },
    { ...original, role: "assistant" },
  ]) {
    const output = { messages: [changed, { role: "assistant", content: "Done" }] }
    expect(normaliseOutputMessages(output, input)).toEqual(normaliseOutputMessages(output))
  }
  const partial = { messages: [original] }
  expect(normaliseOutputMessages(partial, { messages: [original, original] })).toHaveLength(1)
  expect(normaliseOutputMessages(partial, { messages: [] })).toHaveLength(1)
  expect(normaliseOutputMessages(partial, { messages: [42] })).toHaveLength(1)
  expect(normaliseOutputMessages(partial, null)).toHaveLength(1)
  expect(normaliseOutputMessages([original], input)).toHaveLength(1)
})

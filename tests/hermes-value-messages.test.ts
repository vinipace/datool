import { expect, test } from "bun:test"
import {
  normaliseChatMessages,
  normaliseOutputMessages,
} from "@/src/lib/tracer/value-messages"
import {
  availableValueViews,
  defaultValueView,
  formatValueView,
} from "@/src/lib/tracer/value-views"
import {
  documentForValueView,
  jsonDocument,
  parseValueDocument,
} from "@/src/lib/tracer/dataset-editor"

test("Hermes request envelopes preserve the full conversation and tool calls", () => {
  const messages = [
    { role: "system", content: "Use the terminal." },
    { role: "user", content: "Add 17 and 25." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "terminal", arguments: '{"command":"sum"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      content: '{"output":"42","exit_code":0}',
    },
  ]
  const value = {
    method: "POST",
    body: {
      model: "gpt-6-luna",
      messages,
      tools: [],
      max_completion_tokens: 2000,
    },
  }
  const before = JSON.stringify(value)
  const normalized = normaliseChatMessages(value)!
  expect(normalized.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
  ])
  expect(normalized[2].toolCalls).toEqual([
    { id: "call-1", name: "terminal", arguments: '{"command":"sum"}' },
  ])
  expect(normalized[3].content).toBe(messages[3].content)
  expect(normalized[3].toolCallId).toBe("call-1")
  expect(defaultValueView(value)).toBe("llm")
  expect(normaliseOutputMessages(value)).toEqual(normalized)
  expect(JSON.stringify(value)).toBe(before)
  expect(JSON.parse(formatValueView(value, "json"))).toEqual(value)
})

test("Hermes response envelopes render tool-only messages and final answers", () => {
  for (const assistant_message of [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-2",
          name: "terminal",
          arguments: '{"command":"read"}',
          provider_data: null,
        },
      ],
    },
    { role: "assistant", content: "The answer is **42**.", tool_calls: [] },
  ]) {
    const value = {
      model: "gpt-6-luna",
      finish_reason: "stop",
      assistant_message,
      usage: { prompt_tokens: 12, output_tokens: 3 },
    }
    const before = JSON.stringify(value)
    expect(normaliseOutputMessages(value)).toEqual(
      normaliseChatMessages([assistant_message])
    )
    expect(defaultValueView(value)).toBe("llm")
    expect(availableValueViews(value)).toContain("llm-raw")
    expect(normaliseChatMessages(value)).toBeNull()
    expect(JSON.stringify(value)).toBe(before)
    // Conversation presentation must not strip usage or request settings when
    // the same value is opened in the dataset editor or switched back to JSON.
    const source = jsonDocument(value)
    const preview = documentForValueView(source, "llm")
    expect(preview.readOnly).toBe(true)
    expect(parseValueDocument(preview.document)).toEqual(value)
    expect(JSON.parse(formatValueView(value, "json"))).toEqual(value)
  }
})

test("malformed, truncated and unrelated envelopes retain their JSON fallback", () => {
  const message = { role: "user", content: "Hello" }
  for (const value of [
    { body: { messages: [message] } },
    { method: "GET", body: { model: "example", messages: [message] } },
    { method: "POST", body: { messages: [message] } },
    { method: "POST", body: { model: "example", messages: [] } },
    {
      method: "POST",
      body: { model: "example", messages: [message, "<truncated>"] },
    },
    {
      method: "POST",
      body: { model: "example", messages: [{ content: "Missing role" }] },
    },
    { assistant_message: { role: "assistant", content: "Application field" } },
    { model: "example", finish_reason: "stop", assistant_message: message },
    {
      model: "example",
      finish_reason: "stop",
      assistant_message: { role: "assistant" },
    },
    {
      model: "example",
      finish_reason: "stop",
      assistant_message: "<truncated>",
    },
    { capture: "disabled" },
  ]) {
    expect(normaliseOutputMessages(value)).toBeNull()
    expect(defaultValueView(value)).toBe("json")
    expect(availableValueViews(value)).not.toContain("llm")
  }
})

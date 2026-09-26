import { expect, test } from "bun:test"
import {
  appendChatMessage,
  appendChatResponse,
  readChatInput,
} from "@/src/lib/playground/chat-input"
import {
  changeInputFormat,
  inputDocument,
  parseInputDocument,
} from "@/src/lib/playground/input-document"

test("chat turns preserve history, structured messages, and extra input fields across formats", () => {
  const input = {
    locale: "pt-BR",
    messages: [
      { role: "system", content: "Be concise" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "weather",
            input: { city: "São Paulo" },
          },
        ],
      },
    ],
  }
  const question = appendChatMessage(input, " Weather? ")
  const answer = appendChatResponse(question, { content: "Sunny" })
  expect(answer.messages).toEqual([
    ...input.messages,
    { role: "user", content: "Weather?" },
    { role: "assistant", content: "Sunny" },
  ])
  expect(answer.locale).toBe("pt-BR")
  expect(input.messages).toHaveLength(2)
  let document = inputDocument(answer, "chat")
  for (const format of ["json", "yaml", "form", "chat"] as const) {
    document = changeInputFormat(document, format)
    expect(parseInputDocument(document)).toEqual(answer)
  }
})

test("retrying a pending message does not duplicate it and responses support connected-agent output shapes", () => {
  const input = appendChatMessage({ messages: [] }, "Hello")
  expect(appendChatMessage(input, " ")).toEqual(input)
  for (const output of [
    "Hello back",
    { content: "Hello back" },
    { text: "Hello back" },
  ])
    expect(appendChatResponse(input, output).messages.at(-1)).toEqual({
      role: "assistant",
      content: "Hello back",
    })
  expect(
    appendChatResponse(input, { temperature: 24 }).messages.at(-1)?.content
  ).toBe('{\n  "temperature": 24\n}')
  expect(appendChatResponse(input, undefined)).toEqual(input)
})

test("malformed message lists remain invalid instead of being silently discarded", () => {
  expect(readChatInput({})).toEqual({ messages: [] })
  for (const messages of [
    null,
    "hello",
    ["hello"],
    [{ role: "user" }],
    [{ content: "hello" }],
  ])
    expect(() => readChatInput({ messages })).toThrow("Chat requires messages")
})

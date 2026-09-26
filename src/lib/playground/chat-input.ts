import { normaliseChatMessages } from "@/src/lib/tracer/value-messages"

export type ChatMessage = Record<string, unknown> & { role: string }
type ChatInput = Record<string, unknown> & { messages: ChatMessage[] }

/** Keep the original messages, including tool calls and structured content. */
export function readChatInput(value: unknown): ChatInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Chat requires an input object with a messages array.")
  const input = value as Record<string, unknown>
  const messages = input.messages === undefined ? [] : input.messages
  if (
    !Array.isArray(messages) ||
    (messages.length > 0 && !normaliseChatMessages(messages))
  )
    throw new Error(
      "Chat requires messages with a role and content. Edit them in Form, JSON, or YAML."
    )
  return { ...input, messages: messages as ChatMessage[] }
}

export function appendChatMessage(input: unknown, text: string): ChatInput {
  const value = readChatInput(input)
  return text.trim()
    ? {
        ...value,
        messages: [...value.messages, { role: "user", content: text.trim() }],
      }
    : value
}

/** Connected agents return text, a content/text envelope, or structured output. */
export function appendChatResponse(input: unknown, output: unknown): ChatInput {
  const value = readChatInput(input)
  if (output === undefined) return value
  const record =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)
      : null
  const content =
    typeof output === "string"
      ? output
      : typeof record?.content === "string"
        ? record.content
        : typeof record?.text === "string"
          ? record.text
          : JSON.stringify(output, null, 2)
  return {
    ...value,
    messages: [...value.messages, { role: "assistant", content }],
  }
}

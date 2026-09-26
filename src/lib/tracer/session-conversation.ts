import type { Span, TraceSummary } from "./contracts"
import {
  normaliseChatMessages,
  normaliseOutputMessages,
  type InspectorMessage,
} from "./value-messages"

export type ConversationTrace = TraceSummary & { spans: Span[] }

function messages(value: unknown, role: "user" | "assistant", inputValue?: unknown) {
  const normalized = role === "user" ? normaliseChatMessages(value) : normaliseOutputMessages(value, inputValue)
  if (normalized) return normalized
  if (role === "assistant" && value && typeof value === "object" &&
    "text" in value && typeof value.text === "string" && Object.keys(value).length === 1) {
    return [{ role, content: value.text, toolCalls: [] }]
  }
  return typeof value === "string" && value.length
    ? [{ role, content: value, toolCalls: [] }]
    : []
}

/** Model inputs often replay earlier turns. Only remove contiguous history,
 * never globally deduplicate text: repeated user requests are real messages. */
function appendHistory(target: InspectorMessage[], incoming: InspectorMessage[]) {
  // Hermes may replay a tool-call response with empty text instead of null.
  // Compare these equivalent empty contents without changing captured messages.
  const key = (message: InspectorMessage) => JSON.stringify({ ...message, content: message.content ?? "" })
  const existing = target.map(key)
  const keys = incoming.map(key)
  let overlap = Math.min(existing.length, keys.length)
  while (overlap && !keys.slice(0, overlap).every((key, index) => key === existing[existing.length - overlap + index])) overlap--
  target.push(...incoming.slice(overlap))
}

/** Assemble captured conversational messages; model instructions remain on the
 * individual model spans, alongside the unmodified input/output and raw data. */
export function sessionConversation(traces: ConversationTrace[]): InspectorMessage[] {
  const conversation: InspectorMessage[] = []
  const visible = (items: InspectorMessage[]) => items.filter(message =>
    !["system", "developer"].includes(message.role.toLowerCase()))
  for (const trace of [...traces].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    const modelSpans = trace.spans.filter(span => span.kind === "llm")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    const captured = modelSpans.map(span => ({
      input: visible(messages(span.input, "user")),
      output: visible(messages(span.output, "assistant", span.input)),
    })).filter(item => item.input.length || item.output.length)
    if (captured.length) {
      if (!captured[0].input.length) conversation.push(...visible(messages(trace.input, "user")))
      for (const [index, item] of captured.entries()) {
        // A new turn containing only user input is not replayed history, even
        // when a previous interrupted turn received the exact same request.
        if (index > 0 || item.input.some(message => message.role !== "user")) appendHistory(conversation, item.input)
        else conversation.push(...item.input)
        conversation.push(...item.output)
      }
      if (!captured.at(-1)!.output.length) conversation.push(...visible(messages(trace.output, "assistant", trace.input)))
    } else {
      const input = visible(messages(trace.input, "user"))
      if (input.some(message => message.role !== "user")) appendHistory(conversation, input)
      else conversation.push(...input)
      conversation.push(...visible(messages(trace.output, "assistant", trace.input)))
    }
  }
  return conversation
}

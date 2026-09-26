import type { JsonObject } from "./contracts"

export type InspectorToolCall = {
  arguments: unknown
  id: string | null
  name: string
}

export type InspectorMessage = {
  content: unknown
  role: string
  toolCalls: InspectorToolCall[]
  toolCallId?: string
  isError?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameCapturedValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => sameCapturedValue(value, right[index]))
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && sameCapturedValue(left[key], right[key])
  )
}

function isMessageRecord(value: unknown) {
  if (!isRecord(value) || typeof value.role !== "string") return false

  return (
    "content" in value ||
    "parts" in value ||
    "tool_calls" in value ||
    "toolCallId" in value ||
    "tool_call_id" in value
  )
}

function asToolCall(
  value: unknown,
  requireToolPart = false
): InspectorToolCall | null {
  if (!isRecord(value)) return null

  if (
    requireToolPart &&
    value.type !== "tool-call" &&
    value.type !== "tool_call"
  )
    return null

  const functionValue = isRecord(value.function) ? value.function : null
  const name =
    (typeof value.toolName === "string" && value.toolName) ||
    (typeof value.name === "string" && value.name) ||
    (typeof functionValue?.name === "string" && functionValue.name) ||
    null

  if (!name) return null

  const argumentsValue =
    value.args ??
    value.arguments ??
    value.input ??
    functionValue?.arguments ??
    null
  const id =
    typeof value.toolCallId === "string"
      ? value.toolCallId
      : typeof value.id === "string"
        ? value.id
        : null

  return { arguments: argumentsValue, id, name }
}

function collectToolCalls(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((toolCall) => asToolCall(toolCall))
    .filter((toolCall): toolCall is InspectorToolCall => toolCall !== null)
}

function normaliseMessage(value: unknown): InspectorMessage | null {
  if (!isMessageRecord(value)) return null

  const record = value as JsonObject
  const parts = Array.isArray(record.parts)
    ? record.parts
    : Array.isArray(record.content)
      ? record.content
      : []
  const partToolCalls = parts
    .map((part) => asToolCall(part, true))
    .filter((toolCall): toolCall is InspectorToolCall => toolCall !== null)
  const directToolCalls = collectToolCalls(record.tool_calls)
  const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id
    : typeof record.toolCallId === "string" ? record.toolCallId : undefined

  return {
    content: record.content ?? record.parts ?? null,
    role: typeof record.role === "string" ? record.role : "unknown",
    toolCalls: [...directToolCalls, ...partToolCalls],
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
  }
}

/** Match results only to their preceding call ID; names and arrival order are
 * ambiguous for parallel calls. Unmatched results remain visible messages. */
export function groupToolResults(messages: InspectorMessage[]) {
  const grouped: { message: InspectorMessage; toolResults: InspectorMessage[][] }[] = []
  const calls = new Map<string, InspectorMessage[]>()
  for (const message of messages) {
    const results = message.role.toLowerCase() === "tool" && !message.toolCalls.length && message.toolCallId
      ? calls.get(message.toolCallId) : undefined
    if (results) {
      results.push(message)
      continue
    }
    const toolResults = message.toolCalls.map(() => [] as InspectorMessage[])
    grouped.push({ message, toolResults })
    message.toolCalls.forEach((call, index) => {
      if (call.id) calls.set(call.id, toolResults[index])
    })
  }
  return grouped
}

export function toolResultFailed(message: InspectorMessage): boolean {
  if (message.isError) return true
  let result = message.content
  if (typeof result === "string") {
    try { result = JSON.parse(result) } catch { return false }
  }
  if (!isRecord(result)) return false
  const exitCode = result.exit_code ?? result.exitCode
  return result.isError === true || result.is_error === true || result.success === false ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (result.error != null && result.error !== false && result.error !== "") ||
    ["error", "errored", "failed"].includes(String(result.status).toLowerCase())
}

/**
 * Keeps the chat presentation deliberately conservative. A generic JSON
 * object only becomes a transcript when it has explicit role-bearing messages.
 * Hermes preserves model requests as `{ method: "POST", body: { model, messages } }`;
 * read that envelope without changing the captured payload used by raw views.
 */
export function normaliseChatMessages(
  value: unknown
): InspectorMessage[] | null {
  let candidates = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.messages)
      ? value.messages
      : isRecord(value) &&
          value.method === "POST" &&
          isRecord(value.body) &&
          typeof value.body.model === "string" &&
          Array.isArray(value.body.messages)
        ? value.body.messages
        : null

  // LangChain model callbacks wrap a conversation in a batch. A single batch is
  // one transcript; multiple batches remain structured data rather than merging
  // independent conversations or model alternatives into an invented dialogue.
  if (candidates?.length === 1 && Array.isArray(candidates[0]))
    candidates = candidates[0]

  if (
    !candidates ||
    candidates.length === 0 ||
    !candidates.every(isMessageRecord)
  )
    return null

  const messages = candidates
    .map(normaliseMessage)
    .filter((message): message is InspectorMessage => message !== null)

  return messages.length === candidates.length ? messages : null
}

/** Present explicit messages or the adapter's envelope; strings carry no role. */
export function normaliseOutputMessages(
  value: unknown,
  inputValue?: unknown
): InspectorMessage[] | null {
  const messages = normaliseChatMessages(value)
  if (messages) {
    // Agent state returns the input conversation plus new messages. Only omit
    // an exact prefix of explicit state envelopes; never deduplicate by content
    // throughout a conversation or mutate the captured value used by raw views.
    if (
      isRecord(value) && Array.isArray(value.messages) &&
      isRecord(inputValue) && Array.isArray(inputValue.messages) &&
      inputValue.messages.length > 0 &&
      inputValue.messages.every(isMessageRecord) && value.messages.every(isMessageRecord) &&
      inputValue.messages.length <= value.messages.length
    ) {
      const output = value.messages
      if (inputValue.messages.every((message, index) => sameCapturedValue(message, output[index])))
        return messages.slice(inputValue.messages.length)
    }
    return messages
  }
  // Hermes's response hook supplies a normalized assistant message alongside
  // provider metadata and usage. Only project the message in transcript views.
  if (
    isRecord(value) &&
    typeof value.model === "string" &&
    ("finish_reason" in value || "usage" in value) &&
    isRecord(value.assistant_message) &&
    value.assistant_message.role === "assistant"
  )
    return normaliseChatMessages([value.assistant_message])
  // Do not reinterpret structured application output or discard unknown fields.
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.toolCalls) ||
    Object.keys(value).some((key) => key !== "text" && key !== "toolCalls")
  )
    return null
  const toolCalls = collectToolCalls(value.toolCalls)
  if (toolCalls.length !== value.toolCalls.length) return null
  return [{ role: "assistant", content: value.text, toolCalls }]
}

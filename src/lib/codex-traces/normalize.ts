import type { JsonObject, JsonValue, TraceStatus } from "../tracer/contracts"
import { priceLlm } from "../tracer/pricing"
import { aggregateLlmUsage, withTrackingMetrics } from "../tracer/usage"
import type {
  CapturedSpan,
  CodexItem,
  CodexSnapshot,
  CodexThread,
  CodexTurn,
  Telemetry,
} from "./types"

const iso = (value: number) => new Date(value).toISOString()
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined)
const count = (v: unknown) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= 0
    ? Number(v)
    : undefined
const parseJson = (v: JsonValue | undefined): JsonValue | undefined => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
const status = (value: string): TraceStatus =>
  value === "inProgress" || value === "in_progress"
    ? "running"
    : value === "failed" || value === "declined"
      ? "errored"
      : value === "interrupted"
        ? "cancelled"
        : "completed"
const key = (s: CapturedSpan) => `${s.traceId}:${s.spanId}`
type Span = CodexSnapshot["trace"]["spans"][number]

function visibleItem<T extends JsonObject>(source: T): T {
  const item = { ...source }
  delete item.encrypted_content
  if (item.type === "reasoning") delete item.content
  return item
}

function usage(a: JsonObject, prefix = "gen_ai.usage."): JsonObject {
  const turn = prefix === "codex.turn.token_usage."
  return Object.fromEntries(
    Object.entries({
      "usage.input_tokens": count(a[`${prefix}input_tokens`]),
      "usage.output_tokens": count(a[`${prefix}output_tokens`]),
      "usage.cache_read_tokens": count(
        a[
          `${prefix}${turn ? "cached_input_tokens" : "cache_read.input_tokens"}`
        ]
      ),
      "usage.cache_write_tokens": count(
        a[
          `${prefix}${turn ? "cache_write_input_tokens" : "cache_write.input_tokens"}`
        ]
      ),
      "usage.reasoning_tokens": count(
        a[
          turn
            ? `${prefix}reasoning_output_tokens`
            : "codex.usage.reasoning_output_tokens"
        ]
      ),
    }).filter(([, v]) => v !== undefined)
  )
}
function sourceAttributes(s: CapturedSpan): JsonObject {
  return {
    ...s.attributes,
    "otel.trace_id": s.traceId,
    "otel.span_id": s.spanId,
    "otel.parent_span_id": s.parentSpanId,
    "otel.name": s.name,
    "otel.events": s.events as unknown as JsonValue,
    "otel.links": s.links,
  }
}
function promptText(turn: CodexTurn) {
  return turn.items
    .filter((i) => i.type === "userMessage")
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .flatMap((c) =>
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      typeof c.text === "string"
        ? [c.text]
        : []
    )
    .join("\n")
}
function itemInput(item: CodexItem): JsonValue {
  if (item.type === "commandExecution")
    return { command: item.command, cwd: item.cwd }
  return item.arguments ?? item.changes ?? item.query ?? item
}
function itemOutput(item: CodexItem): JsonValue | undefined {
  if (item.type === "commandExecution")
    return {
      stdout: item.aggregatedOutput ?? "",
      exitCode: item.exitCode ?? null,
    }
  return item.result ?? item.contentItems ?? item.error ?? item.output
}

function itemFailed(item: CodexItem) {
  return (
    item.status === "failed" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0)
  )
}

function toolError(item?: CodexItem): JsonObject {
  if (item?.error) return { "error.details": item.error }
  if (typeof item?.exitCode === "number" && item.exitCode !== 0)
    return {
      "error.type": "CommandExitError",
      "error.message": `Command exited with code ${item.exitCode}`,
      "error.exit_code": item.exitCode,
    }
  return { "error.message": "Codex reported an unsuccessful tool execution" }
}

/** One user turn, accurate sampling attempts, tool calls, and the recorded conversation. */
export function normalizeCodexTurn(
  thread: CodexThread,
  turn: CodexTurn,
  telemetry: Telemetry,
  capturedAt: string
): CodexSnapshot {
  turn = { ...turn, items: turn.items.map(visibleItem) }
  const byId = new Map(telemetry.spans.map((s) => [key(s), s]))
  const root = telemetry.spans.find(
    (s) =>
      s.name === "session_task.turn" &&
      s.attributes["turn.id"] === turn.id &&
      s.attributes["thread.id"] === thread.id
  )
  const start = root?.start ?? (turn.startedAt ?? thread.createdAt) * 1000
  const end =
    root?.end ??
    (turn.completedAt != null ? turn.completedAt * 1000 : undefined)
  const threadLogs = telemetry.logs.filter(
    (l) =>
      l.attributes["conversation.id"] === thread.id &&
      l.at >= start - 1000 &&
      (end === undefined || l.at <= end + 100)
  )
  const requests = telemetry.spans.filter(
    (s) =>
      s.name === "try_run_sampling_request" &&
      (s.attributes.turn_id === turn.id ||
        s.attributes["turn.id"] === turn.id) &&
      (!root || s.traceId === root.traceId)
  )
  const ancestors = (span: CapturedSpan): CapturedSpan[] => {
    const result: CapturedSpan[] = [],
      seen = new Set<string>([key(span)])
    let parent = byId.get(`${span.traceId}:${span.parentSpanId}`)
    while (parent && !seen.has(key(parent))) {
      result.push(parent)
      seen.add(key(parent))
      parent = byId.get(`${parent.traceId}:${parent.parentSpanId}`)
    }
    return result
  }
  const recorded = (thread.recordedItems ?? []).map((record) => ({
    ...record,
    item: visibleItem(record.item),
  }))
  const spans: Span[] = []
  const requestUsage = new Map<string, CapturedSpan[]>()
  for (const s of telemetry.spans) {
    if (count(s.attributes["gen_ai.usage.input_tokens"]) === undefined) continue
    const owner = ancestors(s).find((p) => requests.includes(p))
    if (owner)
      requestUsage.set(owner.spanId, [
        ...(requestUsage.get(owner.spanId) ?? []),
        s,
      ])
  }
  requests.forEach((request, index) => {
    const samples = requestUsage.get(request.spanId) ?? []
    const terminal = samples.at(-1)
    const model = text(request.attributes.model) ?? thread.model ?? undefined
    const requestEnd = terminal?.end ?? request.end
    const completion = threadLogs.find(
      (l) =>
        l.name === "codex.sse_event" &&
        l.attributes["event.kind"] === "response.completed" &&
        l.at >= request.start &&
        l.at <= request.end
    )
    const output = recorded
      .filter(
        (r) =>
          r.at >= request.start &&
          r.at <= requestEnd &&
          (r.item.role === "assistant" ||
            [
              "function_call",
              "custom_tool_call",
              "reasoning",
              "web_search_call",
            ].includes(String(r.item.type)))
      )
      .map((r) => r.item)
    const input = recorded
      .filter((r) => r.at < request.start)
      .map((r) => r.item)
    const llmAttributes = priceLlm({
      ...sourceAttributes(request),
      ...(terminal ? usage(terminal.attributes) : {}),
      ...(model ? { model } : {}),
      provider: thread.modelProvider,
      "codex.input.coverage": input.length
        ? "recorded_context_not_wire_request"
        : "unavailable",
      "codex.output.coverage": output.length
        ? "recorded_response_items"
        : "unavailable",
      "codex.usage.record_count": samples.length,
      "codex.reasoning_effort":
        request.attributes["codex.request.reasoning_effort"] ??
        terminal?.attributes["codex.request.reasoning_effort"] ??
        root?.attributes["codex.turn.reasoning_effort"] ??
        null,
      "codex.timing.source": terminal
        ? "sampling_start_to_response_complete"
        : "sampling_attempt",
      ...(count(completion?.attributes.ttft_ms) !== undefined
        ? { "ttft.ms": count(completion?.attributes.ttft_ms) }
        : {}),
    })
    spans.push({
      id: request.spanId,
      kind: "function",
      name: `Step ${index + 1}`,
      startedAt: iso(request.start),
      endedAt: iso(request.end),
      status: request.error ? "errored" : "completed",
      attributes: sourceAttributes(request),
    })
    spans.push({
      id: `${request.spanId}-llm`,
      parentId: request.spanId,
      kind: "llm",
      name: model ?? "Codex model call",
      startedAt: iso(request.start),
      endedAt: iso(requestEnd),
      status: request.error ? "errored" : "completed",
      attributes: llmAttributes,
      ...(input.length ? { input } : {}),
      ...(output.length ? { output } : {}),
    })
  })

  const toolLogs = threadLogs.filter(
    (l) =>
      l.name === "codex.tool_result" &&
      text(l.attributes.call_id) &&
      l.at >= start &&
      (end === undefined || l.at <= end + 1)
  )
  const handledItems = new Set<string>()
  const toolSources = new Map<string, CapturedSpan>()
  for (const log of toolLogs) {
    const a = log.attributes,
      callId = String(a.call_id)
    const source = telemetry.spans.find((s) => s.attributes.call_id === callId)
    if (source) toolSources.set(callId, source)
    const item = turn.items.find((i) => i.id === callId)
    if (item) handledItems.add(item.id)
    const itemRecord = recorded.find(
      (r) =>
        r.item.call_id === callId &&
        ["custom_tool_call", "function_call"].includes(String(r.item.type))
    )
    const duration = count(a.duration_ms)
    const toolStart =
      source?.start ?? (duration !== undefined ? log.at - duration : log.at)
    const toolEnd = source?.end ?? log.at
    const owner = source
      ? ancestors(source).find((p) => requests.includes(p))
      : undefined
    const temporal = requests.filter(
      (r) => toolStart >= r.start && toolEnd <= r.end + 1
    )
    const request = owner ?? (temporal.length === 1 ? temporal[0] : undefined)
    const name =
      [text(a.tool_namespace), text(a.tool_name)].filter(Boolean).join(".") ||
      "Codex tool"
    const toolStatus =
      a.success === false || a.success === "false" || (item && itemFailed(item))
        ? "errored"
        : "completed"
    spans.push({
      id: `tool-${callId}`,
      kind: "tool",
      name,
      ...(request ? { parentId: request.spanId } : {}),
      startedAt: iso(toolStart),
      endedAt: iso(toolEnd),
      status: toolStatus,
      input:
        parseJson(a.arguments) ??
        itemRecord?.item.input ??
        itemRecord?.item.arguments ??
        (item ? itemInput(item) : null),
      output: item
        ? (itemOutput(item) ?? parseJson(a.output) ?? null)
        : (parseJson(a.output) ?? null),
      attributes: {
        ...(source ? sourceAttributes(source) : {}),
        ...a,
        ...(toolStatus === "errored" ? toolError(item) : {}),
        "codex.call_id": callId,
        "codex.output.truncated": a.output_truncated ?? null,
        "codex.parent.source": owner
          ? "otel_ancestry"
          : request
            ? "unique_sampling_interval"
            : "unavailable",
        ...(item ? { "codex.item": item } : {}),
      },
    })
  }
  // Prefer explicit OTel ancestry; isolated code-mode tool traces have no parent link.
  // Retain them as step siblings instead of inventing a nested parent from overlapping clocks.
  for (const tool of spans.filter((s) => s.kind === "tool")) {
    const source = toolSources.get(String(tool.attributes?.["codex.call_id"]))
    const parent = source
      ? ancestors(source).find(
          (a) =>
            text(a.attributes.call_id) &&
            toolSources.has(String(a.attributes.call_id))
        )
      : undefined
    if (parent) tool.parentId = `tool-${parent.attributes.call_id}`
  }
  for (const item of turn.items) {
    if (
      handledItems.has(item.id) ||
      ["userMessage", "agentMessage", "reasoning"].includes(item.type)
    )
      continue
    const isTool = [
      "commandExecution",
      "mcpToolCall",
      "dynamicToolCall",
      "fileChange",
      "webSearch",
      "collabAgentToolCall",
    ].includes(item.type)
    // Saved items do not always include wall-clock timestamps. Do not fabricate a duration.
    spans.push({
      id: `${isTool ? "tool" : "item"}-${item.id}`,
      kind: isTool ? "tool" : "custom",
      name: text(item.tool) ?? item.type,
      startedAt: iso(start),
      status: itemFailed(item)
        ? "errored"
        : status(String(item.status ?? turn.status)),
      input: itemInput(item),
      ...(itemOutput(item) !== undefined ? { output: itemOutput(item) } : {}),
      attributes: {
        "codex.item": item,
        ...(itemFailed(item) ? toolError(item) : {}),
        "codex.timing.source": "unavailable",
        "codex.reported_duration_ms": item.durationMs ?? null,
      },
    })
  }
  const llms = spans
    .filter((s) => s.kind === "llm")
    .map((s) => s.attributes ?? {})
  const totals = aggregateLlmUsage(llms)
  const declared = root ? usage(root.attributes, "codex.turn.token_usage.") : {}
  const comparable =
    declared["usage.input_tokens"] !== undefined &&
    declared["usage.output_tokens"] !== undefined
  const agrees =
    comparable &&
    totals["usage.input_tokens"] === declared["usage.input_tokens"] &&
    totals["usage.output_tokens"] === declared["usage.output_tokens"] &&
    totals["usage.cache_read_tokens"] === declared["usage.cache_read_tokens"]
  const attributes: JsonObject = withTrackingMetrics({
    ...totals,
    source: "codex",
    "codex.thread_id": thread.id,
    "codex.turn_id": turn.id,
    "codex.cwd": thread.cwd,
    "codex.version": thread.cliVersion,
    "codex.history.coverage": thread.historyCoverage ?? "app_server_items",
    "codex.telemetry.coverage": root ? "otel_turn" : "history_only",
    "codex.usage.turn_reported": declared,
    "codex.usage.reconciliation": comparable
      ? agrees
        ? "matched"
        : "mismatch"
      : "unavailable",
    "codex.response_items": recorded
      .filter((r) => r.at >= start && (end === undefined || r.at <= end))
      .map((r) => ({ at: iso(r.at), ...r.item })),
    "codex.items": turn.items,
    "codex.error": turn.error ?? null,
    ...(root
      ? { "otel.trace_id": root.traceId, "otel.span_id": root.spanId }
      : {}),
  })
  if (comparable && !agrees) {
    attributes["usage.status"] = "partial"
    attributes.metrics = {
      ...(attributes.metrics as JsonObject),
      usageStatus: "partial",
    }
  }
  const prompt = promptText(turn)
  const replies = turn.items.filter((i) => i.type === "agentMessage")
  const finalReplies = replies.filter((i) => i.phase === "final_answer")
  const output = (finalReplies.length ? finalReplies : replies)
    .map((i) => i.text ?? "")
    .join("\n")
  const title =
    prompt.replace(/\s+/g, " ").slice(0, 160) || thread.name || "Codex turn"
  return {
    version: 1,
    capturedAt,
    threadId: thread.id,
    turnId: turn.id,
    session: {
      name: thread.name ?? title,
      createdAt: iso(thread.createdAt * 1000),
      attributes: {
        source: "codex",
        "codex.thread_id": thread.id,
        "codex.cwd": thread.cwd,
        "codex.parent_thread_id": thread.parentThreadId ?? null,
        "codex.forked_from_id": thread.forkedFromId ?? null,
      },
    },
    trace: {
      name: title,
      operation: "codex.turn",
      startedAt: iso(start),
      ...(end !== undefined ? { endedAt: iso(end) } : {}),
      status: status(turn.status),
      group: { type: "agent", name: "Codex", version: thread.cliVersion },
      input: turn.items
        .filter((i) => i.type === "userMessage")
        .map((i) => ({ role: "user", content: i.content ?? [] })),
      output,
      attributes,
      spans,
    },
  }
}

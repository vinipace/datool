import type { Span, TraceSummary } from "@/src/lib/tracer/contracts"

export type TraceIconKind = Span["kind"] | "chat" | "code" | "eval"

function isTraceIconKind(value: unknown): value is TraceIconKind {
  return (
    typeof value === "string" &&
    [
      "agent",
      "chat",
      "code",
      "custom",
      "eval",
      "function",
      "llm",
      "score",
      "task",
      "tool",
      "workflow",
    ].includes(value)
  )
}

export function getTraceIconKind(
  trace: Pick<TraceSummary, "attributes" | "operation" | "group">
): TraceIconKind {
  // Membership never changes the type of the captured operation.
  for (const value of [
    trace.attributes["datool.span.kind"],
    trace.attributes.kind,
    trace.attributes.type,
    trace.operation.split(/[.:/]/)[0],
  ]) {
    if (isTraceIconKind(value)) return value
  }
  const operation = trace.attributes["otel.name"] ?? trace.operation
  if (typeof operation === "string") {
    if (/^ai\.(generateText|streamText)$/.test(operation)) return "function"
    if (/^ai\.(generateText|streamText)\./.test(operation)) return "llm"
    if (operation === "ai.toolCall") return "tool"
  }
  return "custom"
}

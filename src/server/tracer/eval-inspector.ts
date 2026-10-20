import { createHash } from "node:crypto"
import type { Span, TraceForEvaluation } from "@/src/lib/tracer/contracts"

/** Project frozen linked traces into the inspector's single span tree. */
export function evaluationInspectorSpans(trace: TraceForEvaluation): Span[] {
  const spans = [...trace.spans]
  const seen = new Set([trace.id])
  const queue = (trace.linkedTraces ?? []).map((linked) => ({
    linked,
    parentId: null as string | null,
  }))
  const id = (traceId: string, spanId: string | null) =>
    `evidence_${createHash("sha256")
      .update(JSON.stringify([traceId, spanId]))
      .digest("hex")}`
  for (let index = 0; index < queue.length; index++) {
    const { linked, parentId } = queue[index]
    if (seen.has(linked.id)) continue
    seen.add(linked.id)
    const rootId = id(linked.id, null)
    const kind = linked.attributes["datool.span.kind"]
    spans.push({
      id: rootId,
      traceId: trace.id,
      parentId,
      name: linked.name,
      kind: [
        "agent",
        "workflow",
        "function",
        "llm",
        "tool",
        "task",
        "score",
        "custom",
      ].includes(String(kind))
        ? (kind as Span["kind"])
        : "custom",
      group: linked.group,
      input: linked.input,
      output: linked.output,
      status: linked.status,
      startedAt: linked.startedAt,
      endedAt: linked.endedAt,
      durationMs: linked.endedAt
        ? Math.max(0, Date.parse(linked.endedAt) - Date.parse(linked.startedAt))
        : null,
      attributes: { ...linked.attributes, "datool.source.trace.id": linked.id },
    })
    const childIds = new Set(linked.spans.map((span) => span.id))
    for (const span of linked.spans)
      spans.push({
        ...span,
        id: id(linked.id, span.id),
        traceId: trace.id,
        parentId:
          span.parentId && childIds.has(span.parentId)
            ? id(linked.id, span.parentId)
            : rootId,
        attributes: {
          ...span.attributes,
          "datool.source.trace.id": linked.id,
          "datool.source.span.id": span.id,
        },
      })
    queue.push(
      ...(linked.linkedTraces ?? []).map((child) => ({
        linked: child,
        parentId: rootId,
      }))
    )
  }
  return spans
}

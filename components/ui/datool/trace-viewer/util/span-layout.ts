import type { RootNode, SpanNode, TraceNode, VisibleSpan } from "../types"
import { addToRow } from "./tree"

/** Copy the layout nodes so eager rendering does not mutate the captured tree. */
export function orderedSpanNodes(root: RootNode): VisibleSpan[] {
  const pending: VisibleSpan[] = []
  function visit(node: TraceNode, parent?: VisibleSpan) {
    let placedParent = parent
    if ("parent" in node) {
      const visible = {
        ...node,
        parent: (parent ?? root) as SpanNode["parent"],
        row: -1,
        isVisible: true,
        isHovered: false,
      } as VisibleSpan
      pending.push(visible)
      placedParent = visible
    }
    for (const child of node.children
      .slice()
      .sort((a, b) => a.startTime - b.startTime || b.duration - a.duration))
      visit(child, placedParent)
  }
  visit(root)
  return pending
}

export function positionedSpanRows(root: RootNode): VisibleSpan[][] {
  const rows: VisibleSpan[][] = []
  for (const node of orderedSpanNodes(root)) addToRow(rows, node, 0.001)
  return rows.map((row) => row.sort((a, b) => a.startTime - b.startTime))
}

export function matchingSpanIds(root: RootNode, filter: string): Set<string> {
  const attributes = /(?<=^|\s)(?<pair>(?<key>[\w.]+):(?<value>\S*))/g
  const normalized = filter.trim().toLocaleLowerCase()
  const name = normalized
    .replace(attributes, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  const attrs = [...normalized.matchAll(attributes)].map((match) => [
    match.groups?.key ?? "",
    match.groups?.value ?? "",
  ])
  const matches = new Set<string>()
  function visit(node: TraceNode) {
    for (const child of node.children) {
      const span = child.span
      if (
        (span.name.toLocaleLowerCase().includes(name) ||
          span.label?.toLocaleLowerCase().includes(name) ||
          span.spanId.toLocaleLowerCase().includes(name)) &&
        attrs.every(
          ([key, value]) =>
            span.attributes[key] &&
            String(span.attributes[key]).toLocaleLowerCase().includes(value)
        )
      )
        matches.add(span.spanId)
      visit(child)
    }
  }
  visit(root)
  return matches
}

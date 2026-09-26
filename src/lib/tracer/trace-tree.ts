import type { SpanOverview, TraceOverview } from "./contracts"

export type InspectorTreeNode = {
  children: InspectorTreeNode[]
  depth: number
  id: string | null
  span: SpanOverview | null
}

type IndexedSpan = {
  index: number
  span: SpanOverview
}

function timestamp(value: string | null | undefined) {
  if (!value) return null
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) return null
  // Date truncates Python/OTel fractional seconds to milliseconds. Keep the
  // remainder separate so epoch-sized floating-point values cannot round it off.
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})?$/i)?.[1] ?? ""
  return { milliseconds: parsed, remainder: Number(`0.${fraction.slice(3)}`) }
}

function sortSpans(left: IndexedSpan, right: IndexedSpan) {
  const leftTime = timestamp(left.span.startedAt)
  const rightTime = timestamp(right.span.startedAt)

  if (leftTime !== null && rightTime !== null) {
    const difference = leftTime.milliseconds - rightTime.milliseconds || leftTime.remainder - rightTime.remainder
    if (difference) return difference
  }
  if (leftTime === null && rightTime !== null) return 1
  if (leftTime !== null && rightTime === null) return -1
  return left.index - right.index
}

/**
 * Produces a complete, cycle-safe span hierarchy. Broken parent links and the
 * members of a parent cycle sit directly under the trace root so no span is
 * hidden and recursive rendering remains safe.
 */
export function buildInspectorTree(trace: TraceOverview, preserveTraceRoot = false): InspectorTreeNode {
  const ordered = trace.spans
    .map((span, index) => ({ index, span }))
    .sort(sortSpans)
  const nodes = new Map<string, InspectorTreeNode>()

  for (const { span } of ordered) {
    nodes.set(span.id, { children: [], depth: 1, id: span.id, span })
  }

  const parentById = new Map<string, string | null>()
  for (const { span } of ordered) {
    const parentId = span.parentId
    parentById.set(
      span.id,
      parentId && parentId !== span.id && nodes.has(parentId) ? parentId : null
    )
  }

  const cycleIds = new Set<string>()
  const inspected = new Set<string>()
  for (const id of parentById.keys()) {
    if (inspected.has(id)) continue

    const path: string[] = []
    const positions = new Map<string, number>()
    let current: string | null = id

    while (current && !inspected.has(current)) {
      const previousPosition = positions.get(current)
      if (previousPosition !== undefined) {
        for (const cycleId of path.slice(previousPosition))
          cycleIds.add(cycleId)
        break
      }

      positions.set(current, path.length)
      path.push(current)
      current = parentById.get(current) ?? null
    }

    for (const pathId of path) inspected.add(pathId)
  }

  const root: InspectorTreeNode = {
    children: [],
    depth: 0,
    id: null,
    span: null,
  }

  for (const entry of ordered) {
    const node = nodes.get(entry.span.id)!
    const parentId = parentById.get(entry.span.id)
    const parent =
      parentId && !cycleIds.has(entry.span.id) ? nodes.get(parentId) : undefined

    if (parent) {
      parent.children.push(node)
    } else {
      root.children.push(node)
    }
  }

  const onlyChild = root.children.length === 1 ? root.children[0] : null
  // A scorer added to an otherwise span-free invocation must not hide its output.
  const visibleRoot = preserveTraceRoot || onlyChild?.span?.kind === "score" ? root : onlyChild ?? root
  const stack = [{ node: visibleRoot, depth: 0 }]
  while (stack.length) {
    const { node, depth } = stack.pop()!
    node.depth = depth
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 })
  }

  return visibleRoot
}

import { describe, expect, test } from "bun:test"

import {
  buildInspectorTree,
  flattenInspectorTree,
  flattenInspectorForest,
  flattenSessionTraces,
  inspectorNodeKey,
  knownDuration,
  normaliseChatMessages,
  selectedRaw,
  spanTiming,
} from "@/components/tracer/trace-inspector-data"
import type { Span, TraceDetail } from "@/src/lib/tracer/contracts"

const startedAt = "2026-09-07T12:00:00.000Z"

function span(overrides: Partial<Span> & Pick<Span, "id" | "name">): Span {
  return {
    attributes: {},
    durationMs: 10,
    endedAt: "2026-09-07T12:00:00.010Z",
    input: null,
    kind: "task",
    output: null,
    parentId: null,
    startedAt,
    status: "completed",
    traceId: "tr_test",
    ...overrides,
  }
}

function trace(spans: Span[]): TraceDetail {
  return {
    attributes: {},
    durationMs: 10,
    endedAt: "2026-09-07T12:00:00.010Z",
    id: "tr_test",
    input: null,
    name: "Test trace",
    operation: "test",
    output: null,
    scores: [],
    sessionId: null,
    spans,
    startedAt,
    status: "completed",
  }
}

describe("trace inspector data helpers", () => {
  test("orders Python callback siblings within the same millisecond", () => {
    const root = buildInspectorTree(trace([
      span({ id: "sequence", name: "RunnableSequence" }),
      span({ id: "model", name: "DemoAgentModel", parentId: "sequence", kind: "llm",
        startedAt: "2026-09-24T02:16:50.493951+00:00" }),
      span({ id: "prompt", name: "Prompt", parentId: "sequence", kind: "function",
        startedAt: "2026-09-24T02:16:50.493553+00:00" }),
    ]))
    expect(flattenInspectorTree(root, new Set()).map(row => row.node.id)).toEqual([
      "sequence", "prompt", "model",
    ])
  })

  test("compares precise instants across offsets and preserves equal-time ordering", () => {
    const root = buildInspectorTree(trace([
      span({ id: "later", name: "Later", startedAt: "2026-09-24T02:16:50.493553200Z" }),
      span({ id: "equal-first", name: "Equal first", startedAt: "2026-09-23T23:16:50.493553-03:00" }),
      span({ id: "equal-second", name: "Equal second", startedAt: "2026-09-24T02:16:50.493553000Z" }),
      span({ id: "earlier", name: "Earlier", startedAt: "2026-09-24T02:16:50.493553100Z" }),
      span({ id: "milliseconds", name: "Milliseconds", startedAt: "2026-09-24T02:16:50.493Z" }),
      span({ id: "invalid", name: "Invalid", startedAt: "invalid" }),
    ]))
    expect(root.children.map(node => node.id)).toEqual([
      "milliseconds", "equal-first", "equal-second", "earlier", "later", "invalid",
    ])
  })

  test("session trees retain each trace boundary and scope span IDs, collapse and branch guides", () => {
    const first = { ...trace([span({ id: "root", name: "First root" }), span({ id: "leaf", name: "Leaf", parentId: "root" })]), id: "first" }
    const second = { ...trace([span({ id: "root", name: "Second root" })]), id: "second" }
    const empty = { ...trace([]), id: "empty" }
    const rows = flattenSessionTraces([first, second, empty], new Set())
    expect(rows.map(row => [row.trace.id, row.node.id, row.node.depth])).toEqual([
      ["first", null, 1], ["first", "root", 2], ["first", "leaf", 3],
      ["second", null, 1], ["second", "root", 2], ["empty", null, 1],
    ])
    expect(rows[2].continuingDepths).toEqual([1])
    expect(rows[0].isLastChild).toBe(false)
    expect(rows.at(-1)?.isLastChild).toBe(true)
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    const collapsed = flattenSessionTraces([first, second], new Set([inspectorNodeKey("first", null)]))
    expect(collapsed.map(row => [row.trace.id, row.node.id])).toEqual([["first", null], ["second", null], ["second", "root"]])
    expect(flattenSessionTraces([first], new Set()).map(row => row.node.id)).toEqual([null, "root", "leaf"])
    expect(flattenSessionTraces([], new Set())).toEqual([])
  })
  test("run forests retain separate roots and scope duplicate span IDs and collapse to their trace", () => {
    const first = { ...trace([span({ id: "root", name: "First root" }), span({ id: "child", name: "First child", parentId: "root" })]), id: "first" }
    const second = { ...trace([span({ id: "root", name: "Second root" }), span({ id: "child", name: "Second child", parentId: "root" })]), id: "second" }
    const empty = { ...trace([]), id: "empty" }
    const rows = flattenInspectorForest([first, second, empty], new Set([inspectorNodeKey("first", "root")]))
    expect(rows.map(row => [row.trace.id, row.node.id, row.node.depth])).toEqual([
      ["first", "root", 0], ["second", "root", 0], ["second", "child", 1], ["empty", null, 0],
    ])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    expect(rows.filter(row => row.node.depth === 0).every(row => row.continuingDepths.length === 0)).toBe(true)
  })
  test("flattens only expanded branches in preorder with guides for virtual rows", () => {
    const root = buildInspectorTree(trace([
      span({ id: "root", name: "Root" }),
      span({ id: "branch", name: "Branch", parentId: "root" }),
      span({ id: "leaf", name: "Leaf", parentId: "branch" }),
      span({ id: "sibling", name: "Sibling", parentId: "root" }),
    ]))
    const expanded = flattenInspectorTree(root, new Set())
    expect(expanded.map(row => row.node.id)).toEqual(["root", "branch", "leaf", "sibling"])
    expect(expanded[2].continuingDepths).toEqual([1])
    expect(expanded[3].continuingDepths).toEqual([])
    expect(flattenInspectorTree(root, new Set(["branch"])).map(row => row.node.id)).toEqual(["root", "branch", "sibling"])
    expect(flattenInspectorTree(root, new Set(["root"])).map(row => row.node.id)).toEqual(["root"])
  })

  test("keeps every span visible when parents are cyclic or missing and derives depth after linking", () => {
    const root = buildInspectorTree(
      trace([
        span({
          id: "child",
          name: "Child",
          parentId: "parent",
          startedAt: "2026-09-07T11:59:00.000Z",
        }),
        span({ id: "parent", name: "Parent" }),
        span({ id: "cycle-a", name: "Cycle A", parentId: "cycle-b" }),
        span({ id: "cycle-b", name: "Cycle B", parentId: "cycle-a" }),
        span({ id: "orphan", name: "Orphan", parentId: "missing" }),
      ])
    )

    const parent = root.children.find((node) => node.id === "parent")
    expect(parent?.depth).toBe(1)
    expect(parent?.children.map((node) => node.id)).toEqual(["child"])
    expect(parent?.children[0]?.depth).toBe(2)
    expect(root.children.map((node) => node.id).sort()).toEqual([
      "cycle-a",
      "cycle-b",
      "orphan",
      "parent",
    ])
  })

  test("uses the actual function span as root without an extra trace wrapper", () => {
    const root = buildInspectorTree(trace([
      span({ id: "function", name: "ai.generateText", kind: "function" }),
      span({ id: "model", name: "ai.generateText.doGenerate", kind: "llm", parentId: "function" }),
      span({ id: "tool", name: "calculateBudget", kind: "tool", parentId: "model" }),
    ]))
    expect(root.id).toBe("function")
    expect(root.depth).toBe(0)
    expect(root.children[0].id).toBe("model")
    expect(root.children[0].depth).toBe(1)
    expect(root.children[0].children[0].id).toBe("tool")
    expect(root.children[0].children[0].depth).toBe(2)
    expect(buildInspectorTree(trace([])).id).toBeNull()
  })

  for (const type of ["agent", "workflow"] as const) {
    test(`preserves the function hierarchy when the trace belongs to a ${type} group`, () => {
      const invocation: TraceDetail = {
        ...trace([
          span({ id: "function", name: "ai.generateText", kind: "function" }),
          span({ id: "model", name: "Model", kind: "llm", parentId: "function" }),
          span({ id: "tool", name: "Search", kind: "tool", parentId: "model" }),
        ]),
        group: { type, name: "Travel planner" },
      }
      const root = buildInspectorTree(invocation)
      expect(root.span).toBe(invocation.spans[0])
      expect(root.depth).toBe(0)
      expect(root.children[0].id).toBe("model")
      expect(root.children[0].depth).toBe(1)
      expect(root.children[0].children[0].id).toBe("tool")
      expect(selectedRaw(invocation, root.id)).toBe(invocation.spans[0])
    })

    test(`reuses an actual ${type} root for the same invocation group`, () => {
      const group = { type, name: "Travel planner", version: "v1" }
      const invocation: TraceDetail = {
        ...trace([
          span({ id: "invocation", name: "Travel planner", kind: type, group }),
          span({ id: "function", name: "ai.generateText", kind: "function", parentId: "invocation" }),
        ]),
        group,
      }
      const root = buildInspectorTree(invocation)

      expect(root.id).toBe("invocation")
      expect(root.span).toBe(invocation.spans[0])
      expect(root.depth).toBe(0)
      expect(root.children[0].depth).toBe(1)
      expect(root.children[0].id).toBe("function")
    })
  }

  test("keeps the original kind and group of a single root span", () => {
    const group = { type: "workflow", name: "Research", version: "v1" } as const
    for (const kind of ["function", "llm", "task", "agent", "workflow"] as const) {
      const child = span({ id: "child", name: "Recorded operation", kind,
        group: { type: "agent", name: "Different group" } })
      const root = buildInspectorTree({ ...trace([child]), group })
      expect(root.id).toBe(child.id)
      expect(root.span).toBe(child)
      expect(root.span?.kind).toBe(kind)
    }
  })

  test("keeps separately recorded agent and function spans even when their names match", () => {
    const group = { type: "agent", name: "Extractor" } as const
    const invocation = trace([
      span({ id: "agent", name: group.name, kind: "agent", group }),
      span({ id: "function", name: group.name, kind: "function", parentId: "agent" }),
      span({ id: "model", name: "Model", kind: "llm", parentId: "function" }),
    ])
    const root = buildInspectorTree(invocation)
    expect(flattenInspectorTree(root, new Set()).map(row => row.node.id)).toEqual(["agent", "function", "model"])
    expect(root.span).toBe(invocation.spans[0])
    expect(root.children[0].span).toBe(invocation.spans[1])
  })

  test("retains grouped roots with no spans or multiple roots", () => {
    const group = { type: "workflow", name: "Reconcile prompts" } as const
    const empty = buildInspectorTree({ ...trace([]), group })
    expect(empty.id).toBeNull()
    expect(empty.children).toEqual([])

    const multiple = buildInspectorTree({
      ...trace([span({ id: "first", name: "First" }), span({ id: "second", name: "Second" })]),
      group,
    })
    expect(multiple.id).toBeNull()
    expect(multiple.children.map((node) => node.id)).toEqual(["first", "second"])
  })

  test("does not extend unknown terminal timing to the current clock", () => {
    const completed = span({
      durationMs: null,
      endedAt: null,
      id: "unknown",
      name: "Unknown",
    })
    const running = span({
      durationMs: null,
      endedAt: null,
      id: "running",
      name: "Running",
      status: "running",
    })
    const now = new Date(startedAt).getTime() + 1_000

    expect(spanTiming(completed, now)).toBeNull()
    expect(spanTiming(running, now)).toEqual({
      end: now,
      start: new Date(startedAt).getTime(),
    })
    expect(knownDuration(null, "completed")).toBe("Duration unavailable")
  })

  test("recognises only actual message arrays and marked AI SDK tool-call parts", () => {
    expect(
      normaliseChatMessages({
        messages: [{ role: "assistant", content: "Hello" }],
      })
    ).toEqual([{ content: "Hello", role: "assistant", toolCalls: [] }])
    expect(
      normaliseChatMessages([
        {
          content: [
            {
              name: "image",
              type: "image",
              url: "https://example.invalid/image.png",
            },
            {
              args: { city: "Rio" },
              toolCallId: "call_1",
              toolName: "getWeather",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ])?.[0]?.toolCalls
    ).toEqual([
      { arguments: { city: "Rio" }, id: "call_1", name: "getWeather" },
    ])
    expect(
      normaliseChatMessages({ messages: [{ title: "not a chat message" }] })
    ).toBeNull()
  })
})

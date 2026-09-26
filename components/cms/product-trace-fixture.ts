import type { Span, TraceDetail } from "@/src/lib/tracer/contracts"

/** Public, synthetic example data. Never contains customer traces. */
const startedAt = "2026-09-01T10:00:00.000Z"
const question = "Can I return my order after 45 days?"
const policy = "Returns are accepted within 30 days of delivery."
const answer = "Yes! You can return your order within 60 days."
const spans: Span[] = [
  {
    id: "support",
    name: "support.agent",
    kind: "agent",
    parentId: null,
    startedAt,
    endedAt: "2026-09-01T10:00:02.800Z",
    durationMs: 2800,
    input: question,
    output: answer,
    attributes: {},
    traceId: "support-example",
    status: "completed",
  },
  {
    id: "retrieve",
    name: "search.documents",
    kind: "tool",
    parentId: "support",
    startedAt,
    endedAt: "2026-09-01T10:00:01.900Z",
    durationMs: 1900,
    input: { query: "return policy", days_since_delivery: 45 },
    output: { policy, source: "returns-policy.md" },
    attributes: {},
    traceId: "support-example",
    status: "completed",
  },
  {
    id: "generate",
    name: "generate.answer",
    kind: "llm",
    parentId: "support",
    startedAt: "2026-09-01T10:00:01.900Z",
    endedAt: "2026-09-01T10:00:02.600Z",
    durationMs: 700,
    input: [
      { role: "user", content: question },
      { role: "tool", content: policy },
    ],
    output: answer,
    attributes: {},
    traceId: "support-example",
    status: "completed",
  },
  {
    id: "verify",
    name: "verify.sources",
    kind: "function",
    parentId: "support",
    startedAt: "2026-09-01T10:00:02.600Z",
    endedAt: "2026-09-01T10:00:02.800Z",
    durationMs: 200,
    input: { answer, policy },
    output: {
      passed: false,
      reason: "The answer says 60 days. The source says 30.",
    },
    attributes: {},
    traceId: "support-example",
    status: "completed",
  },
]
export const productExampleTrace: TraceDetail = {
  id: "support-example",
  name: "support.agent",
  operation: "support.agent",
  attributes: {},
  startedAt,
  endedAt: "2026-09-01T10:00:02.800Z",
  durationMs: 2800,
  status: "completed",
  input: question,
  output: answer,
  sessionId: null,
  spans,
  scores: [],
}

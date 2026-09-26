import type {
  ApiEnvelope,
  ApiList,
  Session,
  SessionDetail,
  Span,
  TraceDetail,
  TraceOverview,
  TraceSummary,
} from "@/src/lib/tracer/contracts"

export const storybookTraceId = "trace-storybook-001"
export const storybookSessionId = "session-storybook-001"
export const storybookStartedAt = "2026-09-10T14:30:00.000Z"

export const traceRow: TraceSummary = {
  attributes: {
    "datool.span.kind": "workflow",
    "deployment.environment": "storybook",
    "gen_ai.request.model": "gpt-5.6",
    "gen_ai.usage.input_tokens": 842,
    "gen_ai.usage.output_tokens": 216,
    "service.name": "support-copilot",
    tags: ["release-review", "priority"],
  },
  durationMs: 2_480,
  endedAt: "2026-09-10T14:30:02.480Z",
  group: { name: "Customer support", type: "workflow", version: "2026.09" },
  id: storybookTraceId,
  input: {
    messages: [{ content: "Where is my latest invoice?", role: "user" }],
  },
  name: "Resolve invoice question",
  operation: "workflow.resolveInvoiceQuestion",
  output: {
    answer: {
      text: "Your September invoice is ready in the billing portal.",
    },
  },
  sessionId: storybookSessionId,
  spanStats: {
    errorCount: 0,
    llmCalls: 1,
    llmDurationMs: 1_240,
    spanCount: 4,
    toolCalls: 1,
  },
  startedAt: storybookStartedAt,
  status: "completed",
}

export const erroredTraceRow: TraceSummary = {
  ...traceRow,
  attributes: {
    "datool.span.kind": "agent",
    "service.name": "support-copilot",
    tags: ["retry-needed"],
  },
  durationMs: 860,
  endedAt: "2026-09-10T14:25:00.860Z",
  id: "trace-storybook-002",
  input: { message: "Summarize the account history" },
  name: "Summarize account history",
  operation: "agent.accountSummary",
  output: null,
  spanStats: {
    errorCount: 1,
    llmCalls: 0,
    llmDurationMs: null,
    spanCount: 2,
    toolCalls: 1,
  },
  startedAt: "2026-09-10T14:25:00.000Z",
  status: "errored",
}

export const traceRows: TraceSummary[] = [traceRow, erroredTraceRow]

export const traceSpans: Span[] = [
  {
    attributes: { "service.name": "support-copilot" },
    durationMs: 2_480,
    endedAt: "2026-09-10T14:30:02.480Z",
    group: { name: "Customer support", type: "workflow", version: "2026.09" },
    id: "span-storybook-root",
    input: traceRow.input,
    kind: "workflow",
    name: "Resolve invoice question",
    output: traceRow.output,
    parentId: null,
    startedAt: storybookStartedAt,
    status: "completed",
    traceId: storybookTraceId,
  },
  {
    attributes: {
      "gen_ai.request.model": "gpt-5.6",
      "gen_ai.usage.input_tokens": 842,
      "gen_ai.usage.output_tokens": 216,
    },
    durationMs: 1_240,
    endedAt: "2026-09-10T14:30:01.440Z",
    id: "span-storybook-model",
    input: [
      { content: "Where is my latest invoice?", role: "user" },
      { content: "I will check the billing records.", role: "assistant" },
    ],
    kind: "llm",
    name: "Generate invoice response",
    output: { text: "Your September invoice is ready in the billing portal." },
    parentId: "span-storybook-root",
    startedAt: "2026-09-10T14:30:00.200Z",
    status: "completed",
    traceId: storybookTraceId,
  },
  {
    attributes: { "tool.name": "billing_lookup" },
    durationMs: 340,
    endedAt: "2026-09-10T14:30:01.840Z",
    id: "span-storybook-tool",
    input: { customerId: "customer-001" },
    kind: "tool",
    name: "billing_lookup",
    output: { invoiceStatus: "ready" },
    parentId: "span-storybook-root",
    startedAt: "2026-09-10T14:30:01.500Z",
    status: "completed",
    traceId: storybookTraceId,
  },
  {
    attributes: { reason: "No further action required" },
    durationMs: 120,
    endedAt: "2026-09-10T14:30:02.200Z",
    id: "span-storybook-score",
    input: null,
    kind: "score",
    name: "Answer quality",
    output: { score: 0.94 },
    parentId: "span-storybook-root",
    startedAt: "2026-09-10T14:30:02.080Z",
    status: "completed",
    traceId: storybookTraceId,
  },
]

export const traceDetail: TraceDetail = {
  ...traceRow,
  scores: [
    {
      evalResultId: "eval-result-storybook-001",
      evaluatorId: "evaluator-storybook-001",
      evaluatorName: "Answer groundedness",
      evalRunId: "eval-run-storybook-001",
      name: "Groundedness",
      reasoning:
        "The response refers to the invoice state returned by the tool.",
      score: 0.94,
      status: "ok",
    },
  ],
  spans: traceSpans,
}

function withoutSpanPayload(span: Span) {
  const { input, output, ...overviewSpan } = span
  void input
  void output
  return overviewSpan
}

export const traceOverview: TraceOverview = {
  attributes: traceDetail.attributes,
  durationMs: traceDetail.durationMs,
  endedAt: traceDetail.endedAt,
  group: traceDetail.group,
  id: traceDetail.id,
  name: traceDetail.name,
  nextScoreCursor: traceDetail.nextScoreCursor,
  nextSpanCursor: traceDetail.nextSpanCursor,
  operation: traceDetail.operation,
  scores: traceDetail.scores,
  sessionId: traceDetail.sessionId,
  spanStats: traceDetail.spanStats,
  spans: traceSpans.map(withoutSpanPayload),
  startedAt: traceDetail.startedAt,
  status: traceDetail.status,
}

export const storybookSession: Session = {
  attributes: { kind: "chat", source: "storybook" },
  createdAt: "2026-09-10T14:20:00.000Z",
  id: storybookSessionId,
  name: "Invoice support conversation",
  traceCount: traceRows.length,
  updatedAt: "2026-09-10T14:30:02.480Z",
}

export const storybookSessionDetail: SessionDetail = {
  ...storybookSession,
  nextCursor: null,
  traces: traceRows,
}

export function envelope<T>(data: T): ApiEnvelope<T> {
  return { data }
}

export function list<T>(
  items: T[],
  nextCursor: string | null = null
): ApiList<T> {
  return { items, nextCursor, total: items.length }
}

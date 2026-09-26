import type {
  JsonObject,
  JsonValue,
  Span,
  TraceDetail,
} from "@/src/lib/tracer/contracts"
import { aggregateLlmUsage } from "@/src/lib/tracer/usage"
import { productExampleTrace } from "./product-trace-fixture"

// Entirely synthetic usage and costs for the preview, not current model pricing.
function llm(
  model: string,
  input: number,
  output: number,
  cost: number
): JsonObject {
  return {
    model,
    "usage.input_tokens": input,
    "usage.output_tokens": output,
    "cost.usd": cost,
    "cost.status": "estimated",
  }
}

type Step = {
  name: string
  kind: Span["kind"]
  offset: number
  duration: number
  input: JsonValue
  output: JsonValue
  attributes?: JsonObject
}
type Example = {
  name: string
  kind: Exclude<Span["kind"], "tool" | "score">
  duration: number
  input: JsonValue
  output: JsonValue
  attributes?: JsonObject
  status?: "completed" | "errored"
  steps?: Step[]
}

function withUsage(trace: TraceDetail): TraceDetail {
  const calls = trace.spans.filter((span) => span.kind === "llm")
  const attributes: JsonObject = {
    ...trace.attributes,
    demo: true,
    ...(calls.length
      ? aggregateLlmUsage(calls.map((span) => span.attributes))
      : {
          "usage.input_tokens": 0,
          "usage.output_tokens": 0,
          "usage.total_tokens": 0,
          "usage.llm_calls": 0,
          "cost.usd": 0,
          "cost.status": "estimated",
        }),
  }
  return {
    ...trace,
    attributes,
    spans: trace.spans.map((span) =>
      span.parentId === null && span.kind !== "llm"
        ? { ...span, attributes: { ...span.attributes, ...attributes } }
        : span
    ),
    spanStats: {
      spanCount: trace.spans.length,
      llmCalls: calls.length,
      llmDurationMs: calls.reduce(
        (sum, span) => sum + (span.durationMs ?? 0),
        0
      ),
      toolCalls: trace.spans.filter((span) => span.kind === "tool").length,
      errorCount: trace.spans.filter((span) => span.status === "errored")
        .length,
    },
  }
}

function exampleTrace(example: Example, index: number): TraceDetail {
  const id = `preview-${example.name}`
  const start = Date.parse("2026-09-01T09:59:00.000Z") - index * 73_000
  const timestamp = (offset: number) => new Date(start + offset).toISOString()
  const root: Span = {
    id: `${id}.root`,
    traceId: id,
    parentId: null,
    name: example.name,
    kind: example.kind,
    status: example.status ?? "completed",
    startedAt: timestamp(0),
    endedAt: timestamp(example.duration),
    durationMs: example.duration,
    input: example.input,
    output: example.output,
    attributes: example.attributes ?? {},
  }
  const children: Span[] = (example.steps ?? []).map((step, index) => ({
    id: `${id}.step-${index + 1}`,
    traceId: id,
    parentId: root.id,
    name: step.name,
    kind: step.kind,
    status: "completed",
    startedAt: timestamp(step.offset),
    endedAt: timestamp(step.offset + step.duration),
    durationMs: step.duration,
    input: step.input,
    output: step.output,
    attributes: step.attributes ?? {},
  }))
  return withUsage({
    id,
    name: example.name,
    operation: example.name,
    attributes: { ...example.attributes, "datool.span.kind": example.kind },
    input: example.input,
    output: example.output,
    status: root.status,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    durationMs: root.durationMs,
    sessionId: null,
    scores: [],
    spans: [root, ...children],
  })
}

const invoice = {
  invoice_number: "INV-2048",
  vendor: "Northstar Studio",
  currency: "USD",
  line_items: [
    { description: "Design subscription", quantity: 2, unit_price: 120 },
  ],
  subtotal: 240,
  tax: 19.2,
  total: 259.2,
  due_date: "2026-09-30",
}
const meetingSummary =
  "## Product sync\n\nThe team agreed to ship saved views on Friday.\n\n### Action items\n- Maya: finish keyboard navigation by Thursday.\n- Theo: validate the migration on staging.\n- Sam: prepare release notes.\n\n**Open question:** Should shared views be editable by all project members?"

const catalogQuery = {
  query: "wireless keyboard",
  filters: { in_stock: true, max_price: 100 },
  limit: 3,
}
const catalogMatches = [
  {
    sku: "KB-104",
    name: "Studio Keyboard",
    price: 79,
    currency: "USD",
    stock: 42,
    relevance: 0.96,
  },
  {
    sku: "KB-208",
    name: "Travel Keyboard",
    price: 59,
    currency: "USD",
    stock: 18,
    relevance: 0.91,
  },
  {
    sku: "KB-310",
    name: "Compact Keyboard",
    price: 89,
    currency: "USD",
    stock: 7,
    relevance: 0.87,
  },
]

const examples: Example[] = [
  {
    name: "invoice.workflow",
    kind: "workflow",
    duration: 4240,
    input: {
      file: "invoice-september.pdf",
      pages: 2,
      extract: ["vendor", "line_items", "total", "due_date"],
    },
    output: {
      ...invoice,
      validation: "passed",
      destination: "accounts-payable",
    },
    steps: [
      {
        name: "read.document",
        kind: "tool",
        offset: 0,
        duration: 460,
        input: { file: "invoice-september.pdf", pages: [1, 2] },
        output: {
          text: "Northstar Studio · INV-2048\n2 × Design subscription: $120\nSubtotal: $240 · Tax: $19.20\nTotal: $259.20 · Due: September 30",
          confidence: 0.98,
        },
      },
      {
        name: "extract.invoice",
        kind: "llm",
        offset: 460,
        duration: 3500,
        input: [
          {
            role: "system",
            content:
              "Extract invoice fields. Preserve currency and line items. Return structured JSON.",
          },
          {
            role: "user",
            content:
              "Northstar Studio, invoice INV-2048. Two design subscriptions at $120 each. Tax $19.20. Total $259.20. Due September 30, 2026.",
          },
        ],
        output: invoice,
        attributes: llm("gpt-4.1", 3420, 286, 0.00913),
      },
      {
        name: "validate.totals",
        kind: "function",
        offset: 3960,
        duration: 280,
        input: invoice,
        output: {
          valid: true,
          checks: { line_items: true, tax: true, total: true },
          discrepancy: 0,
        },
      },
    ],
  },
  {
    name: "chat.completion",
    kind: "llm",
    duration: 860,
    input: [
      {
        role: "system",
        content: "You are a concise product onboarding assistant.",
      },
      {
        role: "user",
        content: "What is the difference between a trace and a span?",
      },
    ],
    output:
      "A **trace** follows one request from start to finish. A **span** records one step inside it, such as a model call or a database lookup. Open a trace to see how those steps connect and where the time went.",
    attributes: llm("gpt-4.1-mini", 486, 94, 0.00035),
  },
  {
    name: "catalog.lookup",
    kind: "workflow",
    duration: 224,
    input: catalogQuery,
    output: { matches: catalogMatches, total: 3, available: true },
    steps: [
      {
        name: "search.catalog",
        kind: "tool",
        offset: 0,
        duration: 186,
        input: catalogQuery,
        output: { matches: catalogMatches, total: 3, index: "products-v3" },
      },
      {
        name: "validate.availability",
        kind: "function",
        offset: 186,
        duration: 38,
        input: { skus: catalogMatches.map((item) => item.sku) },
        output: { available: true, checked: 3, out_of_stock: [] },
      },
    ],
  },
  {
    name: "research.agent",
    kind: "agent",
    duration: 7820,
    input:
      "Compare our Core and Pro plans for a team running 100,000 traces per month. Cite the internal plan guide.",
    output: {
      recommendation: "Pro",
      reasons: [
        "Includes the team's monthly trace volume",
        "Longer retention for incident reviews",
        "Shared evaluation workflows",
      ],
      citations: [
        { source: "plan-guide.md", section: "Usage and retention" },
        { source: "team-playbook.md", section: "Evaluations" },
      ],
    },
    steps: [
      {
        name: "search.knowledge",
        kind: "tool",
        offset: 0,
        duration: 640,
        input: {
          query: "Core Pro trace volume retention evaluations",
          top_k: 4,
        },
        output: {
          documents: [
            { id: "plan-guide", score: 0.94 },
            { id: "team-playbook", score: 0.88 },
          ],
        },
      },
      {
        name: "fetch.plan-guide",
        kind: "tool",
        offset: 640,
        duration: 380,
        input: { document: "plan-guide.md" },
        output:
          "Core is for individual projects with lighter usage. Pro supports higher trace volumes, longer retention, and shared evaluation workflows.",
      },
      {
        name: "compare.plans",
        kind: "llm",
        offset: 1020,
        duration: 6400,
        input: [
          {
            role: "user",
            content:
              "Choose a plan for a team with 100,000 monthly traces. Use only the retrieved internal documentation and cite each reason.",
          },
          {
            role: "tool",
            content:
              "Pro supports higher trace volumes, longer retention, and shared evaluation workflows. Sources: plan-guide.md; team-playbook.md.",
          },
        ],
        output:
          "**Pro** is the better fit for this team. Its trace allowance accommodates the expected volume, longer retention supports incident review, and shared evaluations help the team test changes. [plan-guide.md, Usage and retention] [team-playbook.md, Evaluations]",
        attributes: llm("gpt-4.1", 6180, 724, 0.01815),
      },
      {
        name: "check.citations",
        kind: "score",
        offset: 7420,
        duration: 400,
        input: { claims: 3, sources: ["plan-guide.md", "team-playbook.md"] },
        output: {
          score: 1,
          passed: true,
          supported_claims: 3,
          unsupported_claims: [],
        },
      },
    ],
  },
  {
    name: "route.request",
    kind: "function",
    duration: 24,
    input: {
      message: "Please send a copy of my latest invoice.",
      locale: "en",
      channel: "chat",
    },
    output: {
      intent: "billing.invoice_copy",
      route: "billing-agent",
      priority: "normal",
      matched_rule: "invoice-request",
      requires_auth: true,
    },
  },
  {
    name: "meeting.summary",
    kind: "llm",
    duration: 3480,
    input: [
      {
        role: "system",
        content:
          "Summarize decisions, action items with owners, and open questions from the meeting transcript.",
      },
      {
        role: "user",
        content:
          "Maya: Keyboard navigation will be ready Thursday.\nTheo: I'll test the saved-view migration on staging.\nSam: I can prepare the release notes for Friday.\nMaya: Agreed, let's ship Friday. We still need to decide who can edit shared views.",
      },
    ],
    output: meetingSummary,
    attributes: llm("gpt-4.1-mini", 2840, 382, 0.00175),
  },
  {
    name: "answer.evaluation",
    kind: "workflow",
    duration: 1420,
    input: {
      answer: "Enterprise plans include unlimited retention.",
      context: "Enterprise retention is configurable up to 365 days.",
    },
    output: {
      score: 0.2,
      passed: false,
      unsupported_claims: ["unlimited retention"],
      reason: "The answer removes the documented 365-day upper limit.",
    },
    steps: [
      {
        name: "judge.groundedness",
        kind: "llm",
        offset: 0,
        duration: 1320,
        input: [
          {
            role: "system",
            content:
              "Score whether the answer is supported by the supplied context. Return a score and unsupported claims.",
          },
          {
            role: "user",
            content:
              "Answer: Enterprise plans include unlimited retention.\nContext: Enterprise retention is configurable up to 365 days.",
          },
        ],
        output: {
          score: 0.2,
          unsupported_claims: ["unlimited retention"],
          reason: "The source specifies a 365-day maximum.",
        },
        attributes: llm("gpt-4.1-mini", 980, 116, 0.00058),
      },
      {
        name: "groundedness.score",
        kind: "score",
        offset: 1320,
        duration: 100,
        input: { judge_score: 0.2, threshold: 0.8 },
        output: {
          score: 0.2,
          passed: false,
          unsupported_claims: ["unlimited retention"],
          reason: "The answer removes the documented 365-day upper limit.",
        },
      },
    ],
  },
  {
    name: "knowledge.answer",
    kind: "workflow",
    duration: 2160,
    input: "How do I rotate an API key without downtime?",
    output:
      "Create a second key, update your application to use it, and verify that new traces arrive. Then revoke the old key. Both keys can remain active during the rollout. [api-key-rotation.md]",
    steps: [
      {
        name: "retrieve.docs",
        kind: "tool",
        offset: 0,
        duration: 320,
        input: { query: "API key rotation zero downtime", top_k: 3 },
        output: {
          chunks: [
            {
              document: "api-key-rotation.md",
              content:
                "Create a new key before revoking the old one. Update the application and verify ingestion, then revoke the previous key.",
              score: 0.97,
            },
          ],
        },
      },
      {
        name: "generate.answer",
        kind: "llm",
        offset: 320,
        duration: 1760,
        input: [
          {
            role: "user",
            content: "How do I rotate an API key without downtime?",
          },
          {
            role: "tool",
            content:
              "Create a new key, update the application, verify ingestion, then revoke the old key. Source: api-key-rotation.md.",
          },
        ],
        output:
          "Create a second key, update your application, and verify new traces arrive. Then revoke the old key. [api-key-rotation.md]",
        attributes: llm("gpt-4.1-mini", 2180, 164, 0.00113),
      },
      {
        name: "validate.answer",
        kind: "function",
        offset: 2080,
        duration: 80,
        input: { required_citations: true, source: "api-key-rotation.md" },
        output: { valid: true, citations: 1, missing_sources: [] },
      },
    ],
  },
  {
    name: "webhook.delivery",
    kind: "task",
    duration: 3000,
    status: "errored",
    input: {
      event: "evaluation.completed",
      destination: "https://hooks.example.com/evaluations",
      attempt: 3,
      payload: { run_id: "demo-run-42", passed: 23, total: 24 },
    },
    output: {
      error: "Connection timed out after 3000 ms",
      code: "ETIMEDOUT",
      retryable: true,
      next_retry_in_seconds: 60,
    },
    attributes: {
      "error.type": "TimeoutError",
      "error.message": "Webhook endpoint did not respond within 3000 ms",
    },
  },
  {
    name: "extract.entities",
    kind: "llm",
    duration: 1120,
    input: [
      {
        role: "system",
        content: "Extract people, companies, dates, and commitments as JSON.",
      },
      {
        role: "user",
        content:
          "Maya from Northstar Studio will send the revised proposal by September 18. Theo will review it the following Monday.",
      },
    ],
    output: {
      people: ["Maya", "Theo"],
      organizations: ["Northstar Studio"],
      dates: ["September 18", "the following Monday"],
      commitments: [
        { owner: "Maya", action: "Send revised proposal", due: "September 18" },
        {
          owner: "Theo",
          action: "Review proposal",
          due: "the following Monday",
        },
      ],
    },
    attributes: llm("gpt-4.1-mini", 640, 212, 0.0006),
  },
  {
    name: "feedback.workflow",
    kind: "workflow",
    duration: 1940,
    input: {
      ticket: "FB-128",
      message:
        "I love the new dashboard, but exporting a large report takes too long.",
      source: "in-app",
    },
    output: {
      sentiment: "mixed",
      topics: ["dashboard", "export-performance"],
      priority: "medium",
      assigned_team: "data-experience",
      saved: true,
    },
    steps: [
      {
        name: "classify.feedback",
        kind: "llm",
        offset: 0,
        duration: 1680,
        input: [
          {
            role: "system",
            content:
              "Classify customer feedback by sentiment, topics, and priority.",
          },
          {
            role: "user",
            content:
              "I love the new dashboard, but exporting a large report takes too long.",
          },
        ],
        output: {
          sentiment: "mixed",
          topics: ["dashboard", "export-performance"],
          priority: "medium",
        },
        attributes: llm("gpt-4.1-mini", 820, 88, 0.00047),
      },
      {
        name: "save.feedback",
        kind: "tool",
        offset: 1680,
        duration: 260,
        input: {
          ticket: "FB-128",
          team: "data-experience",
          labels: ["export-performance", "medium"],
        },
        output: {
          saved: true,
          record_id: "demo-feedback-128",
          queue_position: 4,
        },
      },
    ],
  },
]

export const platformPreviewTraces: TraceDetail[] = [
  withUsage({
    ...productExampleTrace,
    attributes: { "datool.span.kind": "agent" },
    spans: productExampleTrace.spans.map((span) =>
      span.kind === "llm"
        ? { ...span, attributes: llm("gpt-4.1-mini", 1248, 164, 0.00076) }
        : span
    ),
  }),
  ...examples.map(exampleTrace),
]

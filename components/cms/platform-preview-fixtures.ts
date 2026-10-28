import type {
  EvalRunDetail,
  JsonObject,
  JsonValue,
  Span,
  TraceDetail,
} from "@/src/lib/tracer/contracts"
import { aggregateLlmUsage } from "@/src/lib/tracer/usage"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
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

export type PreviewConversation = {
  id: string
  subject: string
  customer: string
  agent: string
  channel: "whatsapp" | "web"
  status: "active" | "handed_off" | "closed"
  updated: string
  messages: InspectorMessage[]
}

const customer = (id: string, content: string): InspectorMessage => ({
  id,
  role: "user",
  content,
  toolCalls: [],
})
const agent = (
  id: string,
  name: string,
  content: string
): InspectorMessage => ({
  id,
  role: "assistant",
  content,
  toolCalls: [],
  author: {
    name,
    image: null,
    agentAvatar: {
      avatarUrl: null,
      avatarStyle: "friendly",
      avatarColor: "green",
    },
  },
})

// Synthetic conversations for the Build preview; names and orders are invented.
export const platformPreviewConversations: PreviewConversation[] = [
  {
    id: "conv-ana",
    subject: "Running shoes for a half marathon",
    customer: "Ana Souza",
    agent: "Stride Sales",
    channel: "whatsapp",
    status: "closed",
    updated: "Oct 28, 09:41",
    messages: [
      customer(
        "m1",
        "Hi! Running shoes for a half marathon? Wide feet, around R$ 600."
      ),
      agent(
        "m2",
        "Stride Sales",
        "Great goal! For wide feet I'd pick the Tempo Glide or the Aurora Wide. Both have a roomy toe box and are under R$ 600."
      ),
      customer("m3", "Do you have the Tempo Glide in size 39?"),
      agent(
        "m4",
        "Stride Sales",
        "Yes, 3 left in 39. Pay with Pix or card here: stride.com.br/checkout/48213"
      ),
    ],
  },
  {
    id: "conv-lucas",
    subject: "Order says delivered but nothing arrived",
    customer: "Lucas Prado",
    agent: "Stride Support",
    channel: "whatsapp",
    status: "handed_off",
    updated: "Oct 28, 09:12",
    messages: [
      customer("m1", "My order 48170 says delivered but nothing arrived."),
      agent(
        "m2",
        "Stride Support",
        "Sorry about that. The carrier scanned it at 14:02 at the building entrance. I've asked our team to open a claim and they'll take it from here."
      ),
    ],
  },
  {
    id: "conv-maria",
    subject: "Which size fits the Aurora Wide?",
    customer: "Maria Lima",
    agent: "Stride Sales",
    channel: "web",
    status: "active",
    updated: "Oct 28, 08:57",
    messages: [
      customer("m1", "Does the Aurora Wide run small?"),
      agent(
        "m2",
        "Stride Sales",
        "It runs true to size. Most customers with wide feet keep their usual size."
      ),
    ],
  },
  {
    id: "conv-joao",
    subject: "Exchange for a bigger size",
    customer: "João Costa",
    agent: "Stride Support",
    channel: "web",
    status: "closed",
    updated: "Oct 27, 19:30",
    messages: [
      customer("m1", "Can I exchange my shoes for one size up?"),
      agent(
        "m2",
        "Stride Support",
        "Of course. I've created a free exchange label, it's in your email now."
      ),
    ],
  },
  {
    id: "conv-bia",
    subject: "Is Pix available at checkout?",
    customer: "Beatriz Alves",
    agent: "Stride Sales",
    channel: "whatsapp",
    status: "closed",
    updated: "Oct 27, 18:04",
    messages: [
      customer("m1", "Can I pay with Pix?"),
      agent(
        "m2",
        "Stride Sales",
        "Yes! Pix and card are both available at checkout."
      ),
    ],
  },
]

export type PreviewEvalCase = {
  id: string
  input: string
  baseline: number
  candidate: number
  reasoning: string
}

// Synthetic eval results for the Improve preview: a new instruction version
// compared against the last one on the same saved conversations.
export const platformPreviewEvalCases: PreviewEvalCase[] = [
  {
    id: "case-wide-feet",
    input: "Running shoes for wide feet under R$ 600",
    baseline: 0.62,
    candidate: 0.94,
    reasoning:
      "Recommends two wide-fit models within budget and offers checkout.",
  },
  {
    id: "case-not-delivered",
    input: "Order says delivered but nothing arrived",
    baseline: 0.48,
    candidate: 0.91,
    reasoning:
      "Checks the carrier scan and hands off to the team with the claim.",
  },
  {
    id: "case-cancel-shipped",
    input: "Cancel an order that already shipped",
    baseline: 0.35,
    candidate: 0.83,
    reasoning:
      "Explains the return option instead of promising a cancellation.",
  },
  {
    id: "case-exchange",
    input: "Exchange for a bigger size",
    baseline: 0.74,
    candidate: 0.95,
    reasoning:
      "Creates the free exchange label and confirms where it was sent.",
  },
  {
    id: "case-aurora-size",
    input: "Does the Aurora Wide run small?",
    baseline: 0.81,
    candidate: 0.88,
    reasoning: "Answers from the size guide and suggests the usual size.",
  },
  {
    id: "case-pix",
    input: "Is Pix available at checkout?",
    baseline: 0.9,
    candidate: 0.97,
    reasoning: "Confirms Pix and card in one short answer.",
  },
]

const average = (key: "baseline" | "candidate") =>
  platformPreviewEvalCases.reduce((sum, item) => sum + item[key], 0) /
  platformPreviewEvalCases.length

function evalRun(
  id: string,
  name: string,
  helpful: number,
  grounded: number
): EvalRunDetail {
  const total = platformPreviewEvalCases.length
  return {
    id,
    name,
    metadata: {},
    completedAt: "2026-10-27T18:12:00.000Z",
    createdAt: "2026-10-27T18:10:00.000Z",
    datasetId: "dataset-stride-support",
    evaluatorIds: ["evaluator-helpful", "evaluator-grounded"],
    resultCount: total * 2,
    results: [],
    score: helpful,
    scores: [
      { name: "Helpful answer", value: helpful },
      { name: "Grounded in policies", value: grounded },
    ],
    status: "completed",
    targetCount: total,
    traceCount: total,
    scorerProgress: [
      ["evaluator-helpful", "Helpful answer", helpful],
      ["evaluator-grounded", "Grounded in policies", grounded],
    ].map(([evaluatorId, scorer, score]) => ({
      evaluatorId: evaluatorId as string,
      name: scorer as string,
      version: 1,
      total,
      score: score as number,
      completed: total,
      error: 0,
      skipped: 0,
      running: 0,
      queued: 0,
    })),
  }
}

export const platformPreviewBaselineRun = evalRun(
  "eval-stride-v1",
  "Stride Support · v1 instructions",
  average("baseline"),
  0.71
)
export const platformPreviewCandidateRun = evalRun(
  "eval-stride-v2",
  "Stride Support · v2 instructions",
  average("candidate"),
  0.93
)

import type {
  CreateDatasetItemInput,
  CreateEvaluatorInput,
  CreateSavedViewInput,
  JsonObject,
} from "@/src/lib/tracer/contracts"

import type { DatoolTracer } from "@/src/lib/tracer/sdk"

const DEMO_QUESTION = "What must be checked before an account launch?"
const REQUIRED_PHRASE = "verify the source record"

export const demoEvaluatorCode = `function evaluate({ trace, datasetItem }) {
  const expected = datasetItem?.expectedOutput?.mustInclude
  const answer = trace.output?.answer?.text ?? ""
  const passed = typeof expected === "string" && answer.includes(expected)

  return {
    score: passed ? 1 : 0,
    passed,
    label: "required phrase",
    reason: passed ? "Expected phrase found" : "Expected phrase missing",
    metrics: { answerLength: answer.length },
  }
}`

export const demoEvaluator: CreateEvaluatorInput = {
  code: demoEvaluatorCode,
  description:
    "Checks whether the workflow answer contains the required launch safeguard.",
  language: "javascript",
  name: "Required launch phrase",
}

export const demoSavedView: CreateSavedViewInput = {
  columns: [
    {
      format: "number",
      id: "score",
      label: "Score",
      selector: "result.score",
    },
    {
      format: "boolean",
      id: "passed",
      label: "Passed",
      selector: "result.passed",
    },
    {
      format: "text",
      id: "reasoning",
      label: "Reasoning",
      selector: "result.reasoning",
    },
    {
      format: "text",
      id: "label",
      label: "Evaluator label",
      selector: "result.metadata.label",
    },
    {
      format: "number",
      id: "answer-length",
      label: "Answer length",
      selector: "result.metadata.metrics.answerLength",
    },
    {
      format: "text",
      id: "answer-text",
      label: "Answer text",
      selector: "trace.output.answer.text",
    },
  ],
  name: "Demo eval review",
  resource: "eval-results",
  sort: { direction: "desc", selector: "result.score" },
}

export type DemoDatasetItem = CreateDatasetItemInput & {
  sourceTraceIndex: number
}

export type DemoWorkflowResult = {
  dataset: {
    description: string
    items: DemoDatasetItem[]
    name: string
  }
  evaluator: CreateEvaluatorInput
  sessionId: string
  traceIds: string[]
  view: CreateSavedViewInput
}

type WorkflowInput = {
  account: {
    locale: string
    plan: string
  }
  question: string
}

type Source = {
  id: string
  title: string
}

function answerText(requiredPhrase: string) {
  return `Before launch, ${requiredPhrase} and approval status.`
}

function baseAttributes(workflow: string): JsonObject {
  return {
    demo: true,
    "demo.workflow": workflow,
    "service.name": "datool-demo",
  }
}

async function captureLaunchReview(
  tracer: DatoolTracer,
  input: WorkflowInput,
  requiredPhrase: string,
  workflow: string
) {
  const trace = await tracer.startTrace({
    group: { type: "workflow", name: "Account launch review" },
    attributes: baseAttributes(workflow),
    input,
    name: "Account launch review",
    operation: "account.launch.review",
  })

  await trace.run(async () => {
    const retrieval = await trace.span(
      {
        attributes: baseAttributes(workflow),
        input: { query: input.question },
        kind: "tool",
        name: "Retrieve launch checklist",
      },
      async () => {
        const sources: Source[] = [
          { id: "policy-launch-checklist", title: "Launch checklist" },
        ]

        return { sources }
      }
    )

    const draft = await trace.span(
      {
        attributes: baseAttributes(workflow),
        input: {
          question: input.question,
          sourceIds: retrieval.sources.map((source) => source.id),
        },
        kind: "agent",
        group: { type: "agent", name: "Account reviewer" },
        name: "Compose launch guidance",
      },
      async () => {
        return trace.span(
          {
            attributes: baseAttributes(workflow),
            input: { requiredPhrase },
            kind: "task",
            name: "Format answer",
          },
          async () => ({ draft: answerText(requiredPhrase) })
        )
      }
    )

    const review = await trace.span(
      {
        attributes: baseAttributes(workflow),
        input: { draft: draft.draft, requiredPhrase },
        kind: "task",
        name: "Review launch guidance",
      },
      async () => ({
        approved: draft.draft.includes(requiredPhrase),
        requiredPhrase,
      })
    )

    return {
      answer: {
        citations: retrieval.sources,
        confidence: review.approved ? 0.93 : 0.4,
        text: draft.draft,
      },
      outcome: review.approved ? "ready_for_review" : "needs_revision",
    }
  })

  return trace.id
}

/**
 * Captures two real, deterministic local workflows. The caller persists the
 * returned dataset, evaluator, eval run, and saved view after trace ingestion
 * completes. IDs vary per invocation; workflow content and graph do not.
 */
export async function runDemoWorkflow(
  tracer: DatoolTracer
): Promise<DemoWorkflowResult> {
  const session = await tracer.createSession({
    attributes: { demo: true, source: "run-demo-action" },
    name: "Demo account launch reviews",
  })
  const input: WorkflowInput = {
    account: { locale: "en-US", plan: "growth" },
    question: DEMO_QUESTION,
  }
  const traceIds = await tracer.withSession(session.id, async () => {
    const passing = await captureLaunchReview(
      tracer,
      input,
      REQUIRED_PHRASE,
      "passing"
    )
    const needsRevision = await captureLaunchReview(
      tracer,
      input,
      "confirm the approval owner",
      "needs-revision"
    )

    return [passing, needsRevision]
  })

  return {
    dataset: {
      description:
        "Deterministic launch-review cases generated by the local demo workflow.",
      items: [
        {
          expectedOutput: { mustInclude: REQUIRED_PHRASE },
          input,
          metadata: { demo: true, expected: "pass" },
          sourceTraceIndex: 0,
        },
        {
          expectedOutput: { mustInclude: REQUIRED_PHRASE },
          input,
          metadata: { demo: true, expected: "fail" },
          sourceTraceIndex: 1,
        },
      ],
      name: "Demo launch reviews",
    },
    evaluator: demoEvaluator,
    sessionId: session.id,
    traceIds,
    view: demoSavedView,
  }
}

import type {
  ApiError,
  Dataset,
  DatasetDetail,
  DatasetFieldSchemas,
  DatasetItem,
  DatasetVersion,
  EvalResult,
  EvalRunComparison,
  EvalRunDetail,
  EvalRunSummary,
  Evaluator,
} from "@/src/lib/tracer/contracts"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import type {
  AvailableApp,
  Attempt,
  Playground,
  PlaygroundDetail,
} from "@/src/lib/playground/contracts"
import type { DatasetLibraryEntry } from "@/src/lib/tracer/dataset-library"
import type { Scorer } from "@/src/lib/tracer/scorers"
import { traceDetail, traceRow, traceRows } from "../traces/fixtures"

export {
  envelope,
  list,
  traceDetail,
  traceRow,
  traceRows,
} from "../traces/fixtures"

export const storybookDatasetId = "dataset-storybook-support"
export const storybookEvaluatorId = "evaluator-storybook-groundedness"
export const storybookEvalRunId = "eval-run-storybook-baseline"
export const storybookComparisonRunId = "eval-run-storybook-candidate"
export const storybookPlaygroundId = "playground-storybook-support"

export const datasetSchemas: DatasetFieldSchemas = {
  input: {
    enforced: true,
    schema: {
      type: "object",
      properties: { question: { type: "string", minLength: 1 } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  expectedOutput: {
    enforced: false,
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
    },
  },
  metadata: {
    enforced: false,
    schema: {
      type: "object",
      properties: { locale: { type: "string" } },
    },
  },
}

export const datasetItems: DatasetItem[] = [
  {
    createdAt: "2026-09-10T14:00:00.000Z",
    datasetId: storybookDatasetId,
    datasetRevision: 3,
    datasetVersionId: "dataset-version-storybook-003",
    expectedOutput: {
      answer: "Your September invoice is ready in the billing portal.",
    },
    id: "dataset-item-storybook-invoice",
    input: { question: "Where is my latest invoice?" },
    metadata: { locale: "en-US", priority: "high" },
    sourceTraceId: traceRow.id,
    updatedAt: "2026-09-10T14:01:00.000Z",
    versionId: "dataset-item-version-storybook-003",
  },
  {
    createdAt: "2026-09-10T13:45:00.000Z",
    datasetId: storybookDatasetId,
    datasetRevision: 3,
    datasetVersionId: "dataset-version-storybook-003",
    expectedOutput: { answer: "You can update the payment method in Billing." },
    id: "dataset-item-storybook-payment",
    input: { question: "How do I change my payment method?" },
    metadata: { locale: "en-US", priority: "normal" },
    sourceTraceId: null,
    updatedAt: "2026-09-10T13:45:00.000Z",
    versionId: "dataset-item-version-storybook-002",
  },
]

export const dataset: Dataset = {
  createdAt: "2026-09-08T10:00:00.000Z",
  description: "Verified billing support examples for release review.",
  fieldSchemas: datasetSchemas,
  id: storybookDatasetId,
  itemCount: datasetItems.length,
  metadata: { owner: "Support Operations", source: "storybook" },
  name: "support/billing-faq",
  revision: 3,
  updatedAt: "2026-09-10T14:01:00.000Z",
  versionId: "dataset-version-storybook-003",
}

export const datasetDetail: DatasetDetail = {
  ...dataset,
  items: datasetItems,
  nextCursor: null,
}

export const datasetVersions: DatasetVersion[] = [
  {
    after: {
      input: datasetItems[0].input,
      expectedOutput: datasetItems[0].expectedOutput,
      metadata: datasetItems[0].metadata,
    },
    before: {
      input: datasetItems[0].input,
      expectedOutput: { answer: "The invoice is available in Billing." },
      metadata: datasetItems[0].metadata,
    },
    createdAt: "2026-09-10T14:01:00.000Z",
    datasetId: storybookDatasetId,
    id: "dataset-change-storybook-003",
    itemId: datasetItems[0].id,
    kind: "item_updated",
    revision: 3,
  },
  {
    after: {
      fieldSchemas: datasetSchemas,
      description: dataset.description,
    },
    before: { fieldSchemas: {}, description: dataset.description },
    createdAt: "2026-09-09T11:00:00.000Z",
    datasetId: storybookDatasetId,
    id: "dataset-change-storybook-002",
    itemId: null,
    kind: "settings_updated",
    revision: 2,
  },
]

const scorerConfig = {
  allowSkip: false,
  chainOfThought: false,
  choices: [],
  code: "function evaluate({ trace, datasetItem }) {\n  return { score: trace.output === datasetItem?.expectedOutput ? 1 : 0 }\n}",
  description: "Checks whether the answer is grounded in the dataset example.",
  messages: [],
  model: "",
  name: "Answer groundedness",
  slug: "answer-groundedness",
  threshold: 0.8,
  type: "javascript" as const,
}

export const evaluator: Evaluator = {
  activeVersion: {
    code: scorerConfig.code,
    config: scorerConfig,
    createdAt: "2026-09-08T10:30:00.000Z",
    evaluatorId: storybookEvaluatorId,
    id: "evaluator-version-storybook-003",
    language: "javascript",
    version: 3,
  },
  createdAt: "2026-09-08T10:30:00.000Z",
  description: scorerConfig.description,
  id: storybookEvaluatorId,
  name: scorerConfig.name,
  updatedAt: "2026-09-10T14:01:00.000Z",
}

export const evaluators: Evaluator[] = [
  evaluator,
  {
    ...evaluator,
    activeVersion: {
      ...evaluator.activeVersion,
      evaluatorId: "evaluator-storybook-style",
      id: "evaluator-version-storybook-style-001",
      version: 1,
    },
    id: "evaluator-storybook-style",
    name: "Clear support style",
  },
]

export const evalResult: EvalResult = {
  completedAt: "2026-09-10T14:30:03.000Z",
  datasetItemId: datasetItems[0].id,
  definition: evaluator.activeVersion,
  error: null,
  evaluatorId: evaluator.id,
  evaluatorName: evaluator.name,
  evaluatorVersion: evaluator.activeVersion.version,
  id: "eval-result-storybook-groundedness",
  metadata: { booleanScore: true, source: "storybook" },
  passed: true,
  reasoning: "The output cites the invoice state from the expected response.",
  runId: storybookEvalRunId,
  score: 0.94,
  status: "passed",
  traceId: traceRow.id,
}

export const evalRows: NonNullable<EvalRunDetail["rows"]> = [
  {
    datasetItemId: datasetItems[0].id,
    expectedOutput: datasetItems[0].expectedOutput,
    id: "eval-row-storybook-invoice",
    results: [evalResult],
    scoringTrace: traceDetail,
    trace: traceRow,
  },
  {
    datasetItemId: datasetItems[1].id,
    expectedOutput: datasetItems[1].expectedOutput,
    id: "eval-row-storybook-payment",
    results: [
      {
        ...evalResult,
        error: "Trace did not include a final answer.",
        id: "eval-result-storybook-payment",
        metadata: {},
        passed: false,
        reasoning: null,
        score: null,
        status: "error",
        traceId: traceRows[1].id,
      },
    ],
    scoringTrace: { ...traceDetail, ...traceRows[1] },
    trace: traceRows[1],
  },
]

export const evalRun: EvalRunDetail = {
  completedAt: "2026-09-10T14:30:03.000Z",
  createdAt: "2026-09-10T14:29:00.000Z",
  datasetId: dataset.id,
  evaluatorIds: [evaluator.id],
  id: storybookEvalRunId,
  metadata: {
    app: { id: "app-storybook-support", name: "Invoice assistant" },
    source: "storybook",
  },
  name: "Invoice assistant · billing FAQ baseline",
  nextCursor: null,
  resultCount: 2,
  results: evalRows.flatMap((row) => row.results),
  rows: evalRows,
  score: 0.94,
  scores: [
    { name: "Answer groundedness", value: 0.94 },
    { name: "Clear support style", value: true },
  ],
  status: "completed",
  targetCount: evalRows.length,
  traceCount: evalRows.length,
}

export const comparisonRows: NonNullable<EvalRunDetail["rows"]> = evalRows.map(
  (row, index) => ({
    ...row,
    id: `candidate-${row.id}`,
    trace: { ...row.trace, durationMs: index === 0 ? 1980 : 1160 },
    results: row.results.map((result) => ({
      ...result,
      id: `candidate-${result.id}`,
      error: null,
      passed: index === 0 ? true : false,
      reasoning:
        index === 0
          ? "The candidate retains the billing answer."
          : "The candidate omitted the required answer.",
      runId: storybookComparisonRunId,
      score: index === 0 ? 1 : 0.4,
      status: index === 0 ? "passed" : "failed",
    })),
  })
)

export const comparisonRun: EvalRunDetail = {
  ...evalRun,
  completedAt: "2026-09-10T15:05:00.000Z",
  createdAt: "2026-09-10T15:03:00.000Z",
  id: storybookComparisonRunId,
  name: "Invoice assistant · billing FAQ candidate",
  results: comparisonRows.flatMap((row) => row.results),
  rows: comparisonRows,
  score: 0.7,
  scores: [
    { name: "Answer groundedness", value: 0.7 },
    { name: "Clear support style", value: false },
  ],
}

export const evalRunSummaries: EvalRunSummary[] = [
  {
    completedAt: evalRun.completedAt,
    createdAt: evalRun.createdAt,
    datasetId: evalRun.datasetId,
    evaluatorIds: evalRun.evaluatorIds,
    id: evalRun.id,
    metadata: evalRun.metadata,
    name: evalRun.name,
    resultCount: evalRun.resultCount,
    score: evalRun.score,
    scores: evalRun.scores,
    status: evalRun.status,
    targetCount: evalRun.targetCount,
    traceCount: evalRun.traceCount,
  },
  {
    completedAt: comparisonRun.completedAt,
    createdAt: comparisonRun.createdAt,
    datasetId: comparisonRun.datasetId,
    evaluatorIds: comparisonRun.evaluatorIds,
    id: comparisonRun.id,
    metadata: comparisonRun.metadata,
    name: comparisonRun.name,
    resultCount: comparisonRun.resultCount,
    score: comparisonRun.score,
    scores: comparisonRun.scores,
    status: comparisonRun.status,
    targetCount: comparisonRun.targetCount,
    traceCount: comparisonRun.traceCount,
  },
]

export const evalComparison: EvalRunComparison = {
  left: evalRun,
  limit: 50,
  nextOffset: null,
  offset: 0,
  pairs: evalRows.map((left, index) => ({
    id: `left:${left.id}`,
    left,
    matchedBy: "dataset item",
    right: comparisonRows[index],
  })),
  right: comparisonRun,
  total: evalRows.length,
}

export const datasetLibraryEntries: DatasetLibraryEntry[] = [
  {
    createdAt: "2026-09-08T10:00:00.000Z",
    description: "Customer-facing support examples.",
    id: "folder-storybook-support",
    itemCount: null,
    kind: "folder",
    name: "support",
    updatedAt: "2026-09-10T14:01:00.000Z",
  },
  {
    createdAt: dataset.createdAt,
    description: dataset.description,
    id: dataset.id,
    itemCount: dataset.itemCount,
    kind: "dataset",
    name: dataset.name,
    updatedAt: dataset.updatedAt,
  },
]

export const supportLibraryEntries: DatasetLibraryEntry[] = [
  {
    ...datasetLibraryEntries[1],
    name: "support/billing-faq",
  },
]

export const scorerRows: Scorer[] = [
  {
    ...scorerConfig,
    createdAt: "2026-09-08T10:30:00.000Z",
    id: "scorer-storybook-groundedness",
    revision: 3,
    updatedAt: "2026-09-10T14:01:00.000Z",
  },
  {
    allowSkip: true,
    chainOfThought: false,
    choices: [
      { label: "Needs work", score: 0 },
      { label: "Clear", score: 1 },
    ],
    code: "",
    createdAt: "2026-09-09T09:00:00.000Z",
    description: "Uses an LLM judge to review tone and clarity.",
    id: "scorer-storybook-style",
    messages: [
      {
        content:
          "Grade the support answer. Input: {{input}} Output: {{output}}",
        role: "user",
      },
    ],
    model: "gpt-5.6-mini",
    name: "Clear support style",
    revision: 1,
    slug: "clear-support-style",
    threshold: 0.8,
    type: "llm",
    updatedAt: "2026-09-10T12:00:00.000Z",
  },
]

export const supportApp: AvailableApp = {
  defaultInput: { question: "Where is my latest invoice?" },
  evaluatorIds: [evaluator.id],
  id: "app-storybook-support",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  internalTracing: true,
  mode: "input",
  name: "Invoice assistant",
  online: true,
  outputSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
  },
  revision: 2,
}

export const availableApps: AvailableApp[] = [supportApp]

export const playground: Playground = {
  id: storybookPlaygroundId,
  name: "Support release review",
  nodes: [
    {
      appId: supportApp.id,
      bindings: {},
      dependsOn: [],
      evaluatorIds: [evaluator.id],
      id: "playground-node-storybook-support",
      input: { question: "Where is my latest invoice?" },
      label: "Invoice assistant",
      position: { x: 120, y: 120 },
      selectedAttemptId: "playground-attempt-storybook-001",
    },
  ],
  revision: 4,
  shared: { customerTier: "enterprise" },
}

export const playgroundAttempt: Attempt = {
  appDefinition: {
    defaultInput: supportApp.defaultInput,
    evaluatorIds: supportApp.evaluatorIds,
    id: supportApp.id,
    inputSchema: supportApp.inputSchema,
    internalTracing: supportApp.internalTracing,
    mode: supportApp.mode,
    name: supportApp.name,
    outputSchema: supportApp.outputSchema,
    revision: supportApp.revision,
  },
  appId: supportApp.id,
  appRevision: supportApp.revision,
  completedAt: "2026-09-10T14:30:03.000Z",
  createdAt: "2026-09-10T14:30:00.000Z",
  evalRunIds: [evalRun.id],
  evaluatorIds: [evaluator.id],
  id: "playground-attempt-storybook-001",
  input: supportApp.defaultInput,
  nodeId: playground.nodes[0].id,
  output: traceRow.output,
  playgroundId: playground.id,
  signature: "storybook-support-attempt-v1",
  status: "completed",
  traceId: traceRow.id,
  upstream: {},
}

export const playgroundDetail: PlaygroundDetail = {
  attempts: [playgroundAttempt],
  playground,
}

export const customField: ComputedColumn = {
  code: "row.input.question",
  format: "text",
  id: "custom-field-storybook-question",
  mode: "expression",
  name: "Question",
}

export function apiError(message: string): ApiError {
  return { error: { code: "INTERNAL_ERROR", message } }
}

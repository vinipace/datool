import type { InvocationGroup } from "./groups"
export type { InvocationGroup } from "./groups"

/**
 * Public wire contracts for the local Datool tracer API and SDK.
 *
 * Every timestamp is an ISO-8601 UTC string. JSON values stay JSON values at
 * the API boundary so a trace can faithfully retain arbitrary workflow input
 * and output without turning them into lossy strings.
 */

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonArray | JsonObject | JsonPrimitive
export type JsonArray = JsonValue[]
export type JsonObject = { [key: string]: JsonValue | undefined }

export type ApiEnvelope<T> = {
  data: T
}

export type ApiList<T> = {
  items: T[]
  nextCursor: string | null
  total?: number
}

export type ApiErrorCode =
  | "READ_BUSY"
  | "READ_TIMEOUT"
  | "READ_RESULT_TOO_LARGE"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "EVALUATION_FAILED"
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"

export type ApiError = {
  error: {
    code: ApiErrorCode
    details?: JsonObject
    message: string
    hint?: string
  }
}

export type TraceStatus = "cancelled" | "completed" | "errored" | "running"
export type SpanStatus = TraceStatus
export type SpanKind =
  | "agent"
  | "custom"
  | "function"
  | "llm"
  | "score"
  | "task"
  | "tool"
  | "workflow"

export type TraceSpanStats = {
  errorCount: number
  llmCalls: number
  llmDurationMs: number | null
  spanCount: number
  toolCalls: number
}

export type TraceSummary = {
  group?: InvocationGroup | null
  attributes: JsonObject
  durationMs: number | null
  endedAt: string | null
  id: string
  input: JsonValue | null
  name: string
  operation: string
  output: JsonValue | null
  sessionId: string | null
  spanStats?: TraceSpanStats
  startedAt: string
  status: TraceStatus
}

export type Span = {
  group?: InvocationGroup | null
  attributes: JsonObject
  durationMs: number | null
  endedAt: string | null
  id: string
  input: JsonValue | null
  kind: SpanKind
  name: string
  output: JsonValue | null
  parentId: string | null
  startedAt: string
  status: SpanStatus
  traceId: string
}

export type TraceScore = Partial<
  Pick<
    EvalResult,
    | "reasoning"
    | "error"
    | "metadata"
    | "evaluatorVersion"
    | "definition"
    | "passed"
  >
> & {
  evaluatorId: string | null
  evaluatorName: string | null
  evalResultId: string | null
  evalRunId: string | null
  name: string
  score: number | null
  valueLabel?: string
  external?: import("./imported-scores").ImportedScore
  status: MetricStatus
}

export type TraceDetail = TraceSummary & {
  nextScoreCursor?: string | null
  nextSpanCursor?: string | null
  scores: TraceScore[]
  spans: Span[]
}

/** Complete navigation data; attributes contain only compact display metrics. */
export type SpanOverview = Omit<Span, "input" | "output">
export type TraceOverview = Omit<TraceDetail, "input" | "output" | "spans"> & {
  spans: SpanOverview[]
  /** The initially visible root arrives with the hierarchy on first open. */
  rootDetail?: Span | TraceSummary
}

export type Session = {
  attributes: JsonObject
  createdAt: string
  id: string
  name: string | null
  traceCount: number
  updatedAt: string
}

export type SessionDetail = Session & {
  nextCursor?: string | null
  traces: TraceSummary[]
}

export type Dataset = {
  versionId?: string
  revision?: number
  metadata?: JsonObject
  fieldSchemas?: DatasetFieldSchemas
  createdAt: string
  description: string | null
  id: string
  itemCount: number
  name: string
  updatedAt: string
}

export type DatasetField = "input" | "expectedOutput" | "metadata"
export type DatasetFieldSchemas = Partial<Record<DatasetField, {
  schema: JsonObject | null
  enforced: boolean
}>>

export type DatasetItem = {
  sourceSpanId?: string | null
  /** Immutable captured invocation; input may separately contain mapped app variables. */
  sourceSpanEvidence?: TraceForEvaluation | null
  observedOutput?: JsonValue | null
  versionId?: string
  datasetRevision?: number
  datasetVersionId?: string
  createdAt: string
  datasetId: string
  expectedOutput: JsonValue | null
  id: string
  input: JsonValue
  metadata: JsonObject
  sourceTraceId: string | null
  updatedAt: string
}

export type DatasetDetail = Dataset & {
  nextCursor?: string | null
  items: DatasetItem[]
}

export type DatasetVersion = {
  id: string
  datasetId: string
  revision: number
  kind: "item_created" | "item_updated" | "item_deleted" | "settings_updated"
  itemId: string | null
  before: JsonObject | null
  after: JsonObject | null
  createdAt: string
}

export type EvaluatorLanguage = "javascript" | "python"

export type EvaluatorVersion = {
  config?: import("./scorers").ScorerInput

  code: string
  createdAt: string
  evaluatorId: string
  id: string
  language: EvaluatorLanguage
  version: number
}

export type Evaluator = {
  activeVersion: EvaluatorVersion
  createdAt: string
  description: string | null
  id: string
  name: string
  updatedAt: string
}

export type EvalRunStatus = "cancelled" | "completed" | "failed" | "partial" | "running"
/** `completed` means the evaluator returned successfully without a binary pass/fail. */
export type EvalResultStatus = "completed" | "error" | "failed" | "passed"

export type EvalResult = {
  definition?: EvaluatorVersion

  completedAt: string | null
  datasetItemId: string | null
  error: string | null
  evaluatorId: string
  evaluatorName: string
  evaluatorVersion: number
  id: string
  metadata: JsonObject
  passed: boolean | null
  reasoning: string | null
  runId: string
  score: number | null
  status: EvalResultStatus
  traceId: string
}

export type EvalRun = {
  groups?: InvocationGroup[]
  groupsResolvedAt?: string | null
  metadata: JsonObject
  scores?: { name: string; value: number | boolean | null }[]
  completedAt: string | null
  createdAt: string
  datasetId: string | null
  datasetItemIds: string[]
  evaluatorIds: string[]
  id: string
  name: string | null
  resultCount: number
  score: number | null
  status: EvalRunStatus
  traceIds: string[]
}

export type EvalRunGroupSummary = {
  id: string
  type: "workflow" | "agent"
  name: string | null
  state: "assigned" | "unassigned" | "unresolved"
  runCount: number
  /** Server-generated filter for independently paging the matching runs. */
  filter: string
}

export type EvalRunSummary = Omit<EvalRun, "traceIds" | "datasetItemIds"> & {
  targetCount: number
  traceCount: number
}

export type ScorerExecutionStatus = "queued" | "running" | "completed" | "error" | "skipped"

export type EvalScorerProgress = Record<ScorerExecutionStatus, number> & {
  evaluatorId: string
  name: string
  version: number
  total: number
  score: number | null
}

export type EvalRunDetail = EvalRunSummary & {
  evaluatorVersionIds?: Record<string, string>
  execution?: { workerOnline: boolean; stalled: boolean; lastProgressAt: string | null; stages: Record<string, number> }
  scorerProgress?: EvalScorerProgress[]
  nextCursor?: string | null
  rows?: {
    id: string
    sourceSpanId?: string | null
    scoringTrace?: TraceForEvaluation
    trace: TraceSummary
    expectedOutput: JsonValue | null
    datasetItemId: string | null
    /** Frozen case identity, retained even when the live dataset item no longer exists. */
    datasetCaseId?: string | null
    stage?: string
    executionError?: string | null
    results: EvalResult[]
    scorerStatuses?: Record<string, ScorerExecutionStatus>
  }[]
  results: EvalResult[]
}

export type EvalRunComparison = {
  configurationChanges?: import("./eval-comparison").RunConfigurationChange[]
  left: EvalRunDetail
  right: EvalRunDetail
  pairs: import("./eval-comparison").EvalPair[]
  total: number
  offset: number
  limit: number
  nextOffset: number | null
}

export type ViewResource = "eval-results" | "traces"
export type ViewColumnFormat = "boolean" | "json" | "number" | "text"

export type SavedViewColumn = {
  format: ViewColumnFormat
  id: string
  label: string
  selector: string
}

export type SavedViewFilter = {
  operator: "equals" | "exists" | "notEquals"
  selector: string
  value?: JsonValue
}

export type SavedViewSort = {
  direction: "asc" | "desc"
  selector: string
}

export type SavedView = {
  columns: SavedViewColumn[]
  createdAt: string
  filters: SavedViewFilter[]
  id: string
  name: string
  resource: ViewResource
  sort: SavedViewSort | null
  updatedAt: string
}

export type SavedViewRow = {
  id: string
  values: Record<string, JsonValue>
}

export type SavedViewData = {
  total: number
  limit: number
  offset: number
  nextOffset: number | null
  columns: SavedViewColumn[]
  rows: SavedViewRow[]
  view: SavedView
}

/** An eval detail page can scope a reusable eval-results view to one run. */
export type SavedViewDataQuery = {
  limit?: number
  offset?: number
  runId?: string
}

export type MetricStatus = "empty" | "error" | "ok"

/** Canonical analytical contracts. */
export type {
  SemanticCatalogMetadata,
  SemanticFilter,
  SemanticQueryInput,
  SemanticResult,
} from "@/src/lib/semantic"

export type CreateSessionInput = {
  attributes?: JsonObject
  id?: string
  name?: string
}

export type CreateSpanInput = {
  group?: InvocationGroup
  attributes?: JsonObject
  endedAt?: string
  id?: string
  input?: JsonValue
  kind?: SpanKind
  name: string
  output?: JsonValue
  parentId?: string | null
  startedAt?: string
  status?: SpanStatus
}

export type CreateTraceInput = {
  group?: InvocationGroup
  attributes?: JsonObject
  endedAt?: string
  id?: string
  input?: JsonValue
  name?: string
  operation?: string
  output?: JsonValue
  sessionId?: string
  spans?: CreateSpanInput[]
  startedAt?: string
  status?: TraceStatus
}

export type PatchTraceInput = {
  attributes?: JsonObject
  endedAt?: string | null
  input?: JsonValue
  name?: string
  operation?: string
  output?: JsonValue
  status?: TraceStatus
}

export type PatchSpanInput = {
  attributes?: JsonObject
  endedAt?: string | null
  input?: JsonValue
  kind?: SpanKind
  name?: string
  output?: JsonValue
  parentId?: string | null
  status?: SpanStatus
}

export type CreateDatasetInput = {
  description?: string
  id?: string
  name: string
}

export type PatchDatasetInput = {
  metadata?: JsonObject
  fieldSchemas?: DatasetFieldSchemas
  description?: string | null
  name?: string
}

export type CreateDatasetItemInput = {
  sourceSpanId?: string
  expectedOutput?: JsonValue
  id?: string
  input: JsonValue
  metadata?: JsonObject
  sourceTraceId?: string
}

export type PatchDatasetItemInput = {
  sourceSpanId?: string | null
  expectedVersionId?: string
  expectedOutput?: JsonValue | null
  input?: JsonValue
  metadata?: JsonObject
  sourceTraceId?: string | null
}

export type CreateEvaluatorInput = {
  code: string
  description?: string
  id?: string
  language: EvaluatorLanguage
  name: string
}

export type PatchEvaluatorInput = {
  code?: string
  description?: string | null
  name?: string
}

export type CreateEvalRunInput = {
  /** Fresh application execution using the existing run's frozen cases and settings. */
  parentRunId?: string
  /** Resolve recorded prompt and scorer revisions instead of latest. */
  useRecordedVersions?: boolean
  /** Internal idempotent request claim, linked atomically before dispatch. */
  agentRequestKey?: string
  promptOverrides?: import("./prompt-overrides").PromptOverrides
  /** Shallow overrides of object case inputs, for connected dataset runs only. */
  inputOverrides?: JsonObject
  /** Internal scheduling option used by the agent job interface. */
  background?: boolean
  datasetVersionId?: string
  evaluatorVersionIds?: Record<string, string>
  sourceRunId?: string
  mode?: "connected" | "traces"
  appId?: string
  /** Internal playground invocation, without creating a dataset. */
  input?: JsonValue
  concurrency?: number

  metadata?: JsonObject
  datasetId?: string
  datasetItemIds?: string[]
  evaluatorIds?: string[]
  name?: string
  traceIds?: string[]
}

export type CreateSavedViewInput = {
  columns: SavedViewColumn[]
  filters?: SavedViewFilter[]
  id?: string
  name: string
  resource: ViewResource
  sort?: SavedViewSort | null
}

export type PatchSavedViewInput = {
  columns?: SavedViewColumn[]
  filters?: SavedViewFilter[]
  name?: string
  sort?: SavedViewSort | null
}

/** A trace shape deliberately safe to pass to the evaluator runner. */
export type TraceForEvaluation = {
  group?: InvocationGroup | null
  selectedSpanId?: string
  provenance?: {
    trace: Pick<TraceSummary, "id" | "startedAt" | "endedAt" | "attributes">
    ancestors: Pick<Span, "id" | "parentId" | "name" | "kind" | "startedAt" | "endedAt" | "attributes">[]
  }
  linkedTraces?: TraceForEvaluation[]
} & Pick<
  TraceDetail,
  | "attributes"
  | "endedAt"
  | "id"
  | "input"
  | "name"
  | "operation"
  | "output"
  | "sessionId"
  | "spans"
  | "startedAt"
  | "status"
>

/** A dataset item shape deliberately safe to pass to the evaluator runner. */
export type DatasetItemForEvaluation = Pick<
  DatasetItem,
  "datasetId" | "expectedOutput" | "id" | "input" | "metadata" | "sourceTraceId" | "sourceSpanId" | "sourceSpanEvidence" | "observedOutput"
>

export type EvaluatorRunErrorKind =
  "protocol" | "runtime" | "sandbox" | "timeout" | "validation"

export type EvaluatorRunResult = {
  error?: {
    kind: EvaluatorRunErrorKind
    message: string
  }
  metadata?: JsonObject
  passed: boolean | null
  reasoning?: string
  score: number | null
}

export type CreateDemoResponse = {
  datasetId: string
  evaluatorId: string
  evalRunId: string
  sessionId: string
  traceIds: string[]
  viewId: string
}

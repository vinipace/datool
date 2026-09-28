import { evalConfigurationChanges } from "@/src/lib/tracer/eval-comparison"
import { collectEvalAttributions, saveEvalAttributions } from "./eval-attribution"
import { resolveRunIteration } from "./eval-iteration"
import { evalExecution, executionState } from "./eval-execution"
import { validatePromptOverrides, type FrozenPromptConfig } from "@/src/lib/tracer/prompt-overrides"
import { effectiveEvalInput, validateInputOverrides } from "@/src/lib/tracer/eval-input-overrides"
import { captureSpanEvidence } from "./span-evidence"
import { createImportedScoreService } from "./imported-scores"
import { validateDatasetItem } from "./dataset-fields"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import { buildInspectorTree } from "@/src/lib/tracer/trace-tree"
import type { DatasetVersion } from "@/src/lib/tracer/contracts"
import { createAgentFoundations } from "./agent-foundations"
import {
  createDatasetInLibrary,
  createDatasetLibraryEntry,
  listDatasetLibrary,
  moveDatasetLibraryEntry,
  patchDatasetInLibrary,
} from "./dataset-library"
import type { CreateLibraryEntry, MoveLibraryEntry } from "@/src/lib/tracer/dataset-library"
import { boundedReadTransaction } from "./read-transaction"
import {
  withReadBudget,
  ReadBudgetError,
  READ_MAX_BYTES,
  READ_BATCH_DEADLINE_MS,
} from "../semantic/read-budget"
import { fitEvalPage } from "./eval-read-page"
import { datasetItemProjection } from "./dataset-preview"
import { DATASET_ITEM_READ_MAX_BYTES, datasetItemPreview } from "@/src/lib/tracer/dataset-payload"
import type { DatasetItemField } from "@/src/lib/tracer/contracts"
import type { DatasetItemPreview } from "@/src/lib/tracer/contracts"
import { evalPairIds } from "./eval-pairs-sql"
import type { EvalPair } from "@/src/lib/tracer/eval-comparison"
import { savedViewSql } from "./saved-view-sql"
import { assertRelationBytes } from "./read-size"
import { traceSearchPageIds } from "./trace-search-page"
import { mutateTraceSelection } from "./trace-selection"
import { listEvalSummaries, listEvalRunGroups } from "./eval-summary-sql"
import { getEvalProgress } from "./eval-progress"
import { collectionSqlFilter, collectionSqlPage } from "./collection-sql"
import { invocationGroupSchema } from "@/src/lib/tracer/groups"
import { createResourceService } from "./resources"
import { scorerEvidence } from "./scorer-execution"
import {
  beginInvocation,
  resolveApp,
  validateAppInput,
} from "../apps/invoke"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import { safeJson, semanticSqlFilters } from "@/src/server/semantic/sql-filters"
import { traceSqlFields } from "@/src/server/metrics/trace-fields"
import { createReactViewService } from "./react-views"
import { createDashboardService } from "./dashboards"
import { createReportService } from "./reports"
import { runTracerEffect } from "./effect"
import { createHumanScoreService } from "./human-scores"
import { humanScoreValueLabel, type HumanScore, type HumanScoreValue } from "@/src/lib/tracer/human-scores"
import { createReviewService } from "./reviews"
import { createPromptService } from "./prompts"
import { runtimePromptCache, type PromptCache } from "./prompt-cache"
import { createScorerService } from "./scorers"
import { createCustomFieldService } from "./custom-fields"
import { createCustomViewService } from "./custom-views"
import { createViewLibrary } from "./view-library"
import { randomUUID } from "node:crypto"

import { and, count, desc, eq, getTableColumns, inArray, notExists, sql } from "drizzle-orm"
import { Effect } from "effect"

import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { runDemoWorkflow } from "@/src/lib/tracer/demo"
import { parseSelector } from "@/src/lib/tracer/selectors"
import { createTracer } from "@/src/lib/tracer/sdk"

import type {
  CreateDatasetInput,
  CreateDatasetItemInput,
  CreateDemoResponse,
  CreateEvalRunInput,
  CreateEvaluatorInput,
  CreateSavedViewInput,
  CreateSessionInput,
  CreateSpanInput,
  CreateTraceInput,
  Dataset,
  DatasetDetail,
  DatasetItem,
  DatasetItemForEvaluation,
  EvalResult,
  EvalResultStatus,
  EvalRunSummary,
  EvalRunDetail,
  Evaluator,
  EvaluatorRunResult,
  JsonObject,
  JsonValue,
  MetricStatus,
  PatchDatasetInput,
  PatchDatasetItemInput,
  PatchEvaluatorInput,
  PatchSavedViewInput,
  PatchSpanInput,
  PatchTraceInput,
  SavedView,
  SavedViewData,
  SavedViewDataQuery,
  Session,
  SessionDetail,
  Span,
  SpanOverview,
  SpanKind,
  SpanStatus,
  TraceDetail,
  TraceOverview,
  TraceForEvaluation,
  TraceScore,
  TraceSpanStats,
  TraceStatus,
  TraceSummary,
  ViewResource,
} from "@/src/lib/tracer/contracts"
import {
  createTracerDatabase,
  getTracerProjectId,
  scopedTracerTransaction,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { tracerEffect, type TracerEffect } from "@/src/server/tracer/effect"
import { notFound, TracerError, validation } from "@/src/server/tracer/errors"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  createSemanticQueryService,
  semanticErrorToTracerError,
  type SemanticQueryService,
} from "@/src/server/semantic"
import {
  datasetItems,
  datasets,
  evaluatorVersions,
  evaluators,
  evalResults,
  evalRunEvaluators,
  evalRunTargets,
  evalRuns,
  savedViews,
  scores,
  sessions,
  spans,
  traces,
} from "@/src/server/tracer/schema"

type TraceRow = typeof traces.$inferSelect
type SpanRow = typeof spans.$inferSelect
type DatasetRow = typeof datasets.$inferSelect
type DatasetItemRow = typeof datasetItems.$inferSelect
type EvaluatorRow = typeof evaluators.$inferSelect
type EvaluatorVersionRow = typeof evaluatorVersions.$inferSelect
type SavedViewDbRow = typeof savedViews.$inferSelect

type ListOptions = {
  includeTotal?: boolean
  filter?: string | null
  cursor?: string | null
  limit?: number
}

type EvalReadOptions = ListOptions & { includeEvidence?: boolean }

type EvalTarget = {
  attributions?: import("@/src/lib/tracer/eval-attribution").EvalAttribution[]
  targetId?: string
  datasetItemReference?: string | null
  datasetItem: DatasetItemForEvaluation | null
  trace: TraceForEvaluation
}

const DEFAULT_LIST_LIMIT = 50
const allowedTraceStatuses = new Set<TraceStatus>([
  "cancelled",
  "completed",
  "errored",
  "running",
])
const allowedSpanKinds = new Set<SpanKind>([
  "function",
  "score",
  "agent",
  "custom",
  "llm",
  "task",
  "tool",
  "workflow",
])

function now() {
  return new Date().toISOString()
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

function toJson(value: JsonValue | undefined) {
  return value === undefined ? null : JSON.stringify(value)
}

function fromJson(value: unknown, fallback: JsonValue = null): JsonValue {
  if (value === null) {
    return fallback
  }

  try {
    return (typeof value === "string" ? JSON.parse(value) : value) as JsonValue
  } catch {
    return fallback
  }
}

function fromObjectJson(value: unknown): JsonObject {
  const parsed = fromJson(value, {})
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as JsonObject
  }
  return {}
}

function durationMs(startedAt: string, endedAt: string | null) {
  if (!endedAt) {
    return null
  }

  const duration = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) ? Math.max(0, duration) : null
}

function emptySpanStats(): TraceSpanStats {
  return {
    errorCount: 0,
    llmCalls: 0,
    llmDurationMs: null,
    spanCount: 0,
    toolCalls: 0,
  }
}

function lifecycle(
  incomingStatus: TraceStatus | SpanStatus | undefined,
  incomingEndedAt: string | null | undefined,
  existingStatus?: TraceStatus | SpanStatus,
  existingEndedAt?: string | null
) {
  const status =
    incomingStatus ??
    existingStatus ??
    (incomingEndedAt ? "completed" : "running")
  const endedAt =
    incomingEndedAt === undefined
      ? status === "running"
        ? null
        : (existingEndedAt ?? now())
      : incomingEndedAt

  if (status === "running") {
    return { endedAt: null, status }
  }

  return { endedAt: endedAt ?? now(), status }
}

function assertTraceStatus(value: string): asserts value is TraceStatus {
  if (!allowedTraceStatuses.has(value as TraceStatus)) {
    throw validation(`Unsupported trace status '${value}'.`)
  }
}

function assertSpanKind(value: string): asserts value is SpanKind {
  if (!allowedSpanKinds.has(value as SpanKind)) {
    throw validation(`Unsupported span kind '${value}'.`)
  }
}

function uniqueIds(ids: string[], subject: string) {
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) {
    throw validation(`${subject} must not contain duplicate IDs.`)
  }
  return unique
}

function toTraceSummary(row: TraceRow): TraceSummary {
  assertTraceStatus(row.status)
  return {
    group: row.groupName
      ? {
          type: row.groupType as "agent" | "workflow",
          name: row.groupName,
          version: row.groupVersion,
        }
      : null,
    attributes: fromObjectJson(row.attributesJson),
    durationMs: durationMs(row.startedAt, row.endedAt),
    endedAt: row.endedAt,
    id: row.id,
    input: fromJson(row.inputJson),
    name: row.name,
    operation: row.operation,
    output: fromJson(row.outputJson),
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    status: row.status,
  }
}

function toSpan(row: SpanRow): Span {
  assertTraceStatus(row.status)
  assertSpanKind(row.kind)
  return {
    group: row.groupName
      ? {
          type: row.groupType as "agent" | "workflow",
          name: row.groupName,
          version: row.groupVersion,
        }
      : null,
    attributes: fromObjectJson(row.attributesJson),
    durationMs: durationMs(row.startedAt, row.endedAt),
    endedAt: row.endedAt,
    id: row.id,
    input: fromJson(row.inputJson),
    kind: row.kind,
    name: row.name,
    output: fromJson(row.outputJson),
    parentId: row.parentId,
    startedAt: row.startedAt,
    status: row.status,
    traceId: row.traceId,
  }
}

function toDataset(row: DatasetRow, itemCount: number): Dataset {
  return {
    versionId: row.versionId,
    revision: row.revision,
    metadata: fromObjectJson(row.metadataJson),
    fieldSchemas: JSON.parse(row.fieldSchemasJson),
    createdAt: row.createdAt,
    description: row.description,
    id: row.id,
    itemCount,
    name: row.name,
    updatedAt: row.updatedAt,
  }
}

function toDatasetItem(row: DatasetItemRow): DatasetItem {
  const sourceSpanEvidence = row.sourceSpanEvidenceJson ? JSON.parse(row.sourceSpanEvidenceJson) : null
  return {
    versionId: row.versionId,
    createdAt: row.createdAt,
    datasetId: row.datasetId,
    expectedOutput: fromJson(row.expectedOutputJson),
    id: row.id,
    input: fromJson(row.inputJson),
    metadata: fromObjectJson(row.metadataJson),
    sourceTraceId: row.sourceTraceId,
    sourceSpanId: row.sourceSpanId,
    sourceSpanEvidence,
    observedOutput: sourceSpanEvidence?.output ?? null,
    updatedAt: row.updatedAt,
  }
}

function toEvaluatorVersion(row: EvaluatorVersionRow) {
  if (row.language !== "javascript" && row.language !== "python") {
    throw new TracerError(
      "INTERNAL_ERROR",
      `Unknown evaluator language '${row.language}'.`
    )
  }
  return {
    ...(row.configJson ? { config: JSON.parse(row.configJson) } : {}),
    code: row.code,
    createdAt: row.createdAt,
    evaluatorId: row.evaluatorId,
    id: row.id,
    language: row.language,
    version: row.version,
  } as const
}

function toSavedView(row: SavedViewDbRow): SavedView {
  const resource = row.resource
  if (resource !== "eval-results" && resource !== "traces") {
    throw new TracerError(
      "INTERNAL_ERROR",
      `Unknown saved view resource '${resource}'.`
    )
  }

  const columns = fromJson(row.columnsJson, [])
  const filters = fromJson(row.filtersJson, [])
  const sort = fromJson(row.sortJson)

  if (!Array.isArray(columns) || !Array.isArray(filters)) {
    throw new TracerError(
      "INTERNAL_ERROR",
      `Saved view '${row.id}' has invalid JSON configuration.`
    )
  }

  return {
    columns: columns as SavedView["columns"],
    createdAt: row.createdAt,
    filters: filters as SavedView["filters"],
    id: row.id,
    name: row.name,
    resource,
    sort: (sort ?? null) as SavedView["sort"],
    updatedAt: row.updatedAt,
  }
}

function scoreStatusFor(result: EvaluatorRunResult): MetricStatus {
  if (result.error) {
    return "error"
  }
  return result.score === null ? "empty" : "ok"
}

function normalizeEvaluatorResult(
  result: EvaluatorRunResult
): EvaluatorRunResult {
  if (result.metadata?.skipped === true && result.score === null)
    return { ...result, passed: null }
  if (result.error) {
    return { ...result, passed: null, score: null }
  }

  if (
    result.score === null ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 1
  ) {
    return {
      error: {
        kind: "protocol",
        message:
          "Evaluator returned an invalid score; scores must be finite numbers from 0 to 1.",
      },
      passed: null,
      score: null,
    }
  }

  return result
}

function evalResultStatusFor(result: EvaluatorRunResult): EvalResultStatus {
  if (result.error) {
    return "error"
  }
  if (result.passed === true) {
    return "passed"
  }
  if (result.passed === false) {
    return "failed"
  }
  return "completed"
}

const allowedSelectorRoots: Record<ViewResource, Set<string>> = {
  traces: new Set(["trace"]),
  "eval-results": new Set(["datasetItem", "evaluator", "result", "trace"]),
}

function assertSelector(resource: ViewResource, selector: string) {
  const segments = parseSelector(selector)
  if (!segments) {
    throw validation(
      `Selector '${selector}' is not a supported dotted JSON path.`
    )
  }
  const root = segments[0]!
  if (!allowedSelectorRoots[resource].has(root)) {
    throw validation(
      `Selector '${selector}' is not available for ${resource} views.`
    )
  }
}

function assertViewConfiguration(
  view: Pick<SavedView, "columns" | "filters" | "resource" | "sort">
) {
  const columnIds = new Set<string>()
  for (const column of view.columns) {
    if (columnIds.has(column.id)) {
      throw validation("Saved view column IDs must be unique.")
    }
    columnIds.add(column.id)
    assertSelector(view.resource, column.selector)
  }
  for (const filter of view.filters) {
    assertSelector(view.resource, filter.selector)
  }
  if (view.sort) {
    assertSelector(view.resource, view.sort.selector)
  }
}

type StoredTraceScore = Pick<
  typeof scores.$inferSelect,
  | "id"
  | "projectId"
  | "traceId"
  | "evaluatorId"
  | "evalResultId"
  | "name"
  | "value"
  | "status"
  | "createdAt"
  | "external"
> & {
  review: {
    sessionId: string
    sessionNumber: number
    reviewerId: string | null
    reviewerName: string | null
    source: "human" | "mcp" | "api"
    provenance: import("@/src/lib/tracer/review-provenance").ReviewProvenance
    editedBy: import("@/src/lib/tracer/review-provenance").ReviewProvenance | null
    comment: string
    definition: HumanScore
    value: HumanScoreValue
    scorerRevision: number | null
  } | null
}

export class TracerService {
  /** Reuse initialization/connection while adopting current code after dev HMR. */
  static withCurrentCode(service: TracerService) {
    return new TracerService(service.database, service.options)
  }

  private readonly projectId: string
  private execution() {
    return evalExecution(this.database, this, { resolveApp: this.options.resolveApp ?? resolveApp, persist: (...args) => this.persistEvaluatorResult(...args) })
  }

  cancelEvalRun(id: string) { return tracerEffect(() => this.execution().cancel(id)) }
  recoverEvalRun(id: string) { return tracerEffect(() => this.execution().recover(id)) }

  readonly agent: ReturnType<typeof createAgentFoundations>
  readonly resources: ReturnType<typeof createResourceService>
  readonly reactViews: ReturnType<typeof createReactViewService>
  readonly reports: ReturnType<typeof createReportService>
  readonly dashboards: ReturnType<typeof createDashboardService>
  readonly humanScores: ReturnType<typeof createHumanScoreService>
  readonly reviews: ReturnType<typeof createReviewService>
  readonly importedScores: ReturnType<typeof createImportedScoreService>
  readonly prompts: ReturnType<typeof createPromptService>
  readonly scorers: ReturnType<typeof createScorerService>
  readonly customFields: ReturnType<typeof createCustomFieldService>
  readonly customViews: ReturnType<typeof createCustomViewService>
  readonly viewLibrary: ReturnType<typeof createViewLibrary>
  private readonly semanticQueryService: SemanticQueryService

  constructor(
    private readonly database: TracerDatabase,
    private readonly options: { resolveApp?: typeof resolveApp; promptCache?: PromptCache } = {}
  ) {
    this.agent = createAgentFoundations(database, (db) => new TracerService(db, this.options))
    this.resources = createResourceService(database)
    this.reactViews = createReactViewService(database)
    this.reports = createReportService(database)
    this.dashboards = createDashboardService(database)
    this.humanScores = createHumanScoreService(database)
    this.reviews = createReviewService(database, async (tx, ids) => {
      if (!ids.length) return []
      const where = and(eq(traces.projectId, this.projectId), inArray(traces.id, ids))!
      await assertRelationBytes(tx, sql`select * from ${traces} where ${where}`)
      const rows = await tx.select().from(traces).where(where)
      const stats = await this.spanStatsByTraceId(ids, tx)
      const summaries = new Map(rows.map((row) => [row.id, {
        ...toTraceSummary(row), spanStats: stats.get(row.id) ?? emptySpanStats(),
      }]))
      return ids.map((id) => summaries.get(id)!)
    })
    this.importedScores = createImportedScoreService(database)
    this.prompts = createPromptService(database, this.options.promptCache)
    this.scorers = createScorerService(database)
    this.customFields = createCustomFieldService(database)
    this.customViews = createCustomViewService(database)
    this.viewLibrary = createViewLibrary(database)
    this.projectId = getTracerProjectId(database)
    this.semanticQueryService = createSemanticQueryService({
      catalog: semanticCatalog,
      database,
    })
  }

  /** Interactive reads share admission, analytics connections and one snapshot. */
  private read<T>(work: (service: TracerService) => Promise<T>, maxBytes = READ_MAX_BYTES): Promise<T> {
    const deadline = Date.now() + READ_BATCH_DEADLINE_MS
    return withReadBudget(this.projectId, () =>
      boundedReadTransaction(this.database, deadline, async (database) => {
        const result = await work(new TracerService(database, this.options))
        if (Date.now() > deadline)
          throw new ReadBudgetError(
            "READ_TIMEOUT",
            "The read exceeded its deadline."
          )
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
          throw new ReadBudgetError(
            "READ_RESULT_TOO_LARGE",
            `This response exceeds ${maxBytes / (1024 * 1024)} MiB. Request fewer rows or narrower columns.`
          )
        return result
      })
    )
  }

  createSession(input: CreateSessionInput): TracerEffect<Session> {
    return tracerEffect(() => this.createSessionUnsafe(input))
  }

  listSessions(options: ListOptions = {}): TracerEffect<{
    items: Session[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listSessionsUnsafe(options))
    )
  }

  getSession(id: string): TracerEffect<SessionDetail> {
    return tracerEffect(() =>
      this.read((service) => service.getSessionUnsafe(id))
    )
  }

  createTrace(input: CreateTraceInput): TracerEffect<TraceDetail> {
    return tracerEffect(() => this.createTraceUnsafe(input))
  }

  listTraces(
    options: ListOptions & { sessionId?: string | null; datasetItemId?: string } = {}
  ): TracerEffect<{
    items: TraceSummary[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listTracesUnsafe(options))
    )
  }

  getTraceArtifact(id: string): TracerEffect<TraceDetail> {
    return tracerEffect(() =>
      this.read((service) => service.getTraceUnsafe(id))
    )
  }

  /** Read both sides of the independent-span-groups migration during rollout. */
  private async spanGroupTypeProjection() {
    const { rows } = await this.database.execute<{ present: boolean }>(sql`
      select exists(select 1 from pg_attribute
        where attrelid = 'spans'::regclass and attname = 'group_type' and not attisdropped) as present`)
    // Before migration 0009, grouped spans use kind as their group type.
    // Checking the catalog avoids reading each span's entire payload via row JSON.
    return rows[0].present
      ? sql<string | null>`group_type`
      : sql<string | null>`case when group_name is not null then kind end`
  }

  listTraceSpans(id: string, options: ListOptions = {}) {
    return tracerEffect(() =>
      this.read(async (service) => {
        await service.assertTraceExists(id)
        const groupType = await service.spanGroupTypeProjection()
        const page = await collectionSqlPage<SpanRow>(
          service.database,
          sql`select id,project_id as "projectId",trace_id as "traceId",parent_id as "parentId",name,kind,${groupType} as "groupType",group_name as "groupName",group_version as "groupVersion",input_json as "inputJson",output_json as "outputJson",attributes_json as "attributesJson",status,started_at as "startedAt",ended_at as "endedAt",started_at_ms as "startedAtMs",ended_at_ms as "endedAtMs" from spans where project_id=${service.projectId} and trace_id=${id}`,
          options,
          "startedAt",
          true
        )
        return { ...page, items: page.items.map(toSpan) }
      })
    )
  }

  /** One snapshot of the entire hierarchy, without fetching payload documents. */
  getTraceOverview(id: string, includeRootDetail = false): TracerEffect<TraceOverview> {
    return tracerEffect(() => this.read(async (service) => {
      // Use stored scalar facts for hover metrics. Never select input/output or
      // the full attributes document for every node in a trace.
      const metrics = sql`jsonb_strip_nulls(jsonb_build_object(
        'usage.input_tokens',input_tokens,'usage.output_tokens',output_tokens,
        'usage.total_tokens',reported_total_tokens,'usage.cache_read_tokens',cached_tokens,
        'usage.cache_write_tokens',written_tokens,'cost.usd',reported_cost_usd,
        'cost.known_usd',cost_usd,'cost.status',cost_status,
        'cost.source',attributes_json->>'cost.source','usage.status',attributes_json->>'usage.status',
        'model',coalesce(nullif(attributes_json->>'gen_ai.response.model',''),
          nullif(attributes_json->>'ai.response.model',''),nullif(attributes_json->>'gen_ai.request.model',''),
          nullif(attributes_json->>'ai.model.id',''),attributes_json->>'model'),
        'usage.reasoning_tokens',coalesce(datool_number(attributes_json,'usage.reasoning_tokens',true),
          datool_number(attributes_json,'gen_ai.usage.reasoning.output_tokens',true),
          datool_number(attributes_json,'ai.usage.outputTokenDetails.reasoningTokens',true),
          datool_number(attributes_json,'ai.usage.reasoningTokens',true))))`
      const traceRelation = sql`select id,name,operation,session_id as "sessionId",
        group_type as "groupType",group_name as "groupName",group_version as "groupVersion",
        status,started_at as "startedAt",ended_at as "endedAt",duration_ms as "durationMs",
        ${metrics} || jsonb_strip_nulls(jsonb_build_object(
          'datool.span.kind',attributes_json->>'datool.span.kind',
          'kind',attributes_json->>'kind','type',attributes_json->>'type',
          'otel.name',attributes_json->>'otel.name')) as attributes
        from traces where project_id=${service.projectId} and id=${id}`
      const groupType = await service.spanGroupTypeProjection()
      const spanRelation = sql`select id,trace_id as "traceId",parent_id as "parentId",name,kind,
        ${groupType} as "groupType",group_name as "groupName",group_version as "groupVersion",
        status,started_at as "startedAt",ended_at as "endedAt",duration_ms as "durationMs",
        ${metrics} as attributes
        from spans where project_id=${service.projectId} and trace_id=${id}
        order by started_at_ms,id`
      await assertRelationBytes(service.database, traceRelation)
      type GroupColumns = Pick<TraceRow, "groupType" | "groupName" | "groupVersion">
      type OverviewRow = Omit<TraceOverview, "group" | "spans" | "scores"> & GroupColumns
      type OverviewSpanRow = Omit<SpanOverview, "group"> & GroupColumns
      const [row] = (await service.database.execute<OverviewRow>(traceRelation)).rows
      if (!row) throw notFound("Trace", id)
      // Keep existing byte/deadline admission. Failure is explicit, never a
      // silently truncated tree. The preflight measures only the projection.
      await assertRelationBytes(service.database, spanRelation)
      const spanRows = (await service.database.execute<OverviewSpanRow>(spanRelation)).rows
      const withGroup = <T extends GroupColumns>(row: T) => {
        const { groupType, groupName, groupVersion, ...fields } = row
        return { ...fields, group: groupName ? { type: groupType as "agent" | "workflow", name: groupName, version: groupVersion } : null }
      }
      const overview: TraceOverview = {
        ...withGroup(row),
        spans: spanRows.map(withGroup),
        scores: [],
        spanStats: (await service.spanStatsByTraceId([id])).get(id) ?? emptySpanStats(),
      }
      if (includeRootDetail) {
        const rootId = buildInspectorTree(overview).id
        overview.rootDetail = rootId === null
          ? await service.getTracePayloadUnsafe(id)
          : await service.getTraceSpanUnsafe(id, rootId)
      }
      return overview
    }))
  }

  /** Exact selected span; ancestors are already present in the overview. */
  getTraceSpan(traceId: string, spanId: string): TracerEffect<Span> {
    return tracerEffect(() => this.read(service => service.getTraceSpanUnsafe(traceId, spanId)))
  }

  private async getTraceSpanUnsafe(traceId: string, spanId: string): Promise<Span> {
    const where = and(eq(spans.projectId, this.projectId), eq(spans.traceId, traceId), eq(spans.id, spanId))
    await assertRelationBytes(this.database, sql`select * from ${spans} where ${where}`)
    const groupType = await this.spanGroupTypeProjection()
    const [row] = await this.database.select({ ...getTableColumns(spans), groupType }).from(spans).where(where).limit(1)
    if (!row) throw notFound("Span", spanId)
    return toSpan(row)
  }

  /** Trace-level payload only, without hydrating child spans or scores. */
  getTracePayload(id: string): TracerEffect<TraceSummary> {
    return tracerEffect(() => this.read(service => service.getTracePayloadUnsafe(id)))
  }

  private async getTracePayloadUnsafe(id: string): Promise<TraceSummary> {
    const where = and(eq(traces.projectId, this.projectId), eq(traces.id, id))
    await assertRelationBytes(this.database, sql`select * from ${traces} where ${where}`)
    const [row] = await this.database.select().from(traces).where(where).limit(1)
    if (!row) throw notFound("Trace", id)
    return toTraceSummary(row)
  }

  getTraceSpanPath(traceId: string, spanId: string) {
    return tracerEffect(() =>
      this.read(async (service) => {
        const ancestry = await service.database
          .execute(sql`with recursive ancestry as (
        select id,parent_id,array[id] as path from spans where project_id=${service.projectId} and trace_id=${traceId} and id=${spanId}
        union all select s.id,s.parent_id,a.path||s.id from spans s join ancestry a on s.id=a.parent_id
        where s.project_id=${service.projectId} and s.trace_id=${traceId} and not s.id=any(a.path) and cardinality(a.path)<=200
      ) select id,parent_id as "parentId" from ancestry order by cardinality(path)`)
        const chain = ancestry.rows as { id: string; parentId: string | null }[]
        if (!chain.length) throw notFound("Span", spanId)
        if (chain.length > 200 || chain.at(-1)?.parentId)
          throw new ReadBudgetError(
            "READ_RESULT_TOO_LARGE",
            "The span ancestry is cyclic or exceeds the 200-row path limit."
          )
        const predicate = and(
          eq(spans.projectId, service.projectId),
          eq(spans.traceId, traceId),
          inArray(
            spans.id,
            chain.map((row) => row.id)
          )
        )
        await assertRelationBytes(
          service.database,
          sql`select * from ${spans} where ${predicate}`
        )
        const rows = await service.database
          .select()
          .from(spans)
          .where(predicate)
          .orderBy(spans.startedAt, spans.id)
        return rows.map(toSpan)
      })
    )
  }

  listTraceScores(id: string, options: ListOptions = {}) {
    return tracerEffect(() =>
      this.read((service) => service.listTraceScoresUnsafe(id, options))
    )
  }

  getTrace(id: string): TracerEffect<TraceDetail> {
    return tracerEffect(() =>
      this.read((service) => service.getTraceUnsafe(id, { limit: 100 }))
    )
  }

  patchTrace(id: string, input: PatchTraceInput): TracerEffect<TraceDetail> {
    return tracerEffect(() => this.patchTraceUnsafe(id, input))
  }

  mutateTraceSelection(input: unknown) {
    return mutateTraceSelection(this.database, input)
  }

  createSpan(traceId: string, input: CreateSpanInput): TracerEffect<Span> {
    return tracerEffect(() => this.createSpanUnsafe(traceId, input))
  }

  patchSpan(id: string, input: PatchSpanInput): TracerEffect<Span> {
    return tracerEffect(() => this.patchSpanUnsafe(id, input))
  }

  listDatasetLibrary(options: Parameters<typeof listDatasetLibrary>[1]) {
    return tracerEffect(() =>
      this.read(service => listDatasetLibrary(service.database, options))
    )
  }

  createDatasetLibraryEntry(input: CreateLibraryEntry) {
    return tracerEffect(() => createDatasetLibraryEntry(this.database, input))
  }

  moveDatasetLibraryEntry(input: MoveLibraryEntry) {
    return tracerEffect(() => moveDatasetLibraryEntry(this.database, input))
  }

  createDataset(input: CreateDatasetInput): TracerEffect<Dataset> {
    return tracerEffect(() => this.createDatasetUnsafe(input))
  }

  listDatasets(options: ListOptions = {}): TracerEffect<{
    items: Dataset[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listDatasetsUnsafe(options))
    )
  }

  listDatasetItems(id: string, options: ListOptions & { preview?: boolean } = {}) {
    return tracerEffect(() =>
      this.read((service) => service.listDatasetItemsUnsafe(id, options))
    )
  }

  getDatasetItem(id: string, options: { fields?: DatasetItemField[] } = {}): TracerEffect<DatasetItemPreview> {
    return tracerEffect(() => this.read(async (service) => {
      const relation = sql`select ${datasetItemProjection(options.fields !== undefined, options.fields)} from dataset_items where project_id=${service.projectId} and id=${id}`
      await assertRelationBytes(service.database, relation, DATASET_ITEM_READ_MAX_BYTES)
      const row = (await service.database.execute(relation)).rows[0] as (DatasetItemRow & Pick<DatasetItemPreview, "omittedFields">) | undefined
      if (!row) throw notFound("Dataset item", id)
      return { ...toDatasetItem(row), ...(row.omittedFields && Object.keys(row.omittedFields).length ? { omittedFields: row.omittedFields } : {}) }
    }, DATASET_ITEM_READ_MAX_BYTES))
  }

  listDatasetVersions(id: string, options: ListOptions = {}) {
    return tracerEffect(() => this.read(async (service) => {
      const [dataset] = await service.database.select({ id: datasets.id }).from(datasets)
        .where(and(eq(datasets.projectId, service.projectId), eq(datasets.id, id)))
      if (!dataset) throw notFound("Dataset", id)
      return collectionSqlPage<DatasetVersion>(service.database,
        sql`select id, dataset_id as "datasetId", revision, kind, item_id as "itemId", before_value as before, after_value as after, created_at as "createdAt"
          from dataset_versions where project_id=${service.projectId} and dataset_id=${id}`,
        options, "revision")
    }))
  }

  getDataset(id: string, options: { includeItems?: boolean } = {}): TracerEffect<DatasetDetail> {
    return tracerEffect(() =>
      this.read((service) => service.getDatasetUnsafe(id, options.includeItems ?? true))
    )
  }

  patchDataset(id: string, input: PatchDatasetInput): TracerEffect<Dataset> {
    return tracerEffect(() => this.patchDatasetUnsafe(id, input))
  }

  deleteDataset(id: string): TracerEffect<{ id: string }> {
    return tracerEffect(async () => {
      const references = this.database
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(eq(evalRuns.datasetId, id))
      const [row] = await this.database
        .delete(datasets)
        .where(and(eq(datasets.id, id), notExists(references)))
        .returning()
      if (!row) {
        const [existing] = await this.database
          .select({ id: datasets.id })
          .from(datasets)
          .where(eq(datasets.id, id))
        if (existing)
          throw new TracerError(
            "CONFLICT",
            "This dataset is referenced by evaluation runs and cannot be deleted."
          )
        throw notFound("Dataset", id)
      }
      return { id }
    })
  }

  getSpanEvidence(traceId: string, spanId: string): TracerEffect<TraceForEvaluation> {
    return tracerEffect(() => this.read(service => captureSpanEvidence(service.database, traceId, spanId)))
  }

  private async datasetEvidence(item: DatasetItemForEvaluation): Promise<TraceForEvaluation> {
    if (!item.sourceTraceId) throw validation("Case requires sourceTraceId for evidence scoring; use connected mode to execute an app.")
    await this.assertTraceExists(item.sourceTraceId)
    if (item.sourceSpanId) {
      const evidence = (await this.agent.hydrateDatasetItem(item)).sourceSpanEvidence
      if (!evidence || evidence.id !== item.sourceTraceId || evidence.selectedSpanId !== item.sourceSpanId)
        throw validation("Span-backed case has missing or mismatched captured evidence; promote the invocation again.")
      return structuredClone(evidence)
    }
    return this.getTraceUnsafe(item.sourceTraceId)
  }

  createDatasetItem(
    datasetId: string,
    input: CreateDatasetItemInput
  ): TracerEffect<DatasetItem> {
    return tracerEffect(() => this.createDatasetItemUnsafe(datasetId, input))
  }

  patchDatasetItem(
    id: string,
    input: PatchDatasetItemInput,
    options: { fields?: DatasetItemField[] } = {}
  ): TracerEffect<DatasetItemPreview> {
    return tracerEffect(async () => {
      const saved = await this.patchDatasetItemUnsafe(id, input)
      return options.fields === undefined ? saved : datasetItemPreview(saved, options.fields)
    })
  }

  deleteDatasetItem(id: string): TracerEffect<{ id: string }> {
    return tracerEffect(() => this.deleteDatasetItemUnsafe(id))
  }

  createEvaluator(input: CreateEvaluatorInput): TracerEffect<Evaluator> {
    return tracerEffect(() => this.createEvaluatorUnsafe(input))
  }

  listEvaluators(options: ListOptions = {}): TracerEffect<{
    items: Evaluator[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listEvaluatorsUnsafe(options))
    )
  }

  getEvaluator(id: string): TracerEffect<Evaluator> {
    return tracerEffect(() =>
      this.read((service) => service.getEvaluatorUnsafe(id))
    )
  }

  patchEvaluator(
    id: string,
    input: PatchEvaluatorInput
  ): TracerEffect<Evaluator> {
    return tracerEffect(() => this.patchEvaluatorUnsafe(id, input))
  }

  getEvalPromptConfig(id: string): TracerEffect<FrozenPromptConfig> {
    return tracerEffect(async () => {
      const [row] = await this.database.select({ metadata: evalRuns.metadataJson }).from(evalRuns)
        .where(and(eq(evalRuns.projectId, this.projectId), eq(evalRuns.id, id)))
      if (!row) throw notFound("Eval run", id)
      const config = JSON.parse(row.metadata ?? "{}").promptConfig as FrozenPromptConfig | undefined
      if (!config) throw validation("This run has no frozen prompt configuration.")
      return config
    })
  }

  createEvalRun(input: CreateEvalRunInput): TracerEffect<EvalRunDetail> {
    return tracerEffect(() => this.createEvalRunUnsafe(input))
  }

  listEvalRuns(options: ListOptions = {}): TracerEffect<{
    items: EvalRunSummary[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listEvalRunsUnsafe(options))
    )
  }

  listEvalRunGroups(options: ListOptions & { groupBy: "workflow" | "agent" }) {
    return tracerEffect(() => this.read(service =>
      listEvalRunGroups(service.database, service.projectId, options)))
  }

  compareEvalRuns(leftId: string, rightId: string, offset = 0, includeEvidence = true) {
    return tracerEffect(() =>
      this.read(async (service) => {
        if (leftId === rightId || !Number.isSafeInteger(offset) || offset < 0)
          throw validation(
            "Comparison requires distinct run IDs and a nonnegative offset."
          )
        await service.assertEvalRunExists(leftId)
        await service.assertEvalRunExists(rightId)
        return service.database.transaction(
          async (tx) => {
            const scoped = new TracerService(
              scopedTracerTransaction(service.database, tx)
            )
            return fitEvalPage(50, async (limit) => {
              const page = await evalPairIds(
                tx as unknown as TracerDatabase,
                service.projectId,
                leftId,
                rightId,
                offset,
                limit
              )
              const left = await scoped.getEvalRunUnsafe(
                leftId,
                { includeEvidence },
                page.pairs.flatMap((p) => (p.lid ? [p.lid] : []))
              )
              const right = await scoped.getEvalRunUnsafe(
                rightId,
                { includeEvidence },
                page.pairs.flatMap((p) => (p.rid ? [p.rid] : []))
              )
              const l = new Map(left.rows?.map((row) => [row.id, row])),
                r = new Map(right.rows?.map((row) => [row.id, row]))
              const pairs: EvalPair[] = page.pairs.map((pair) => ({
                id: pair.lid ? `left:${pair.lid}` : `right:${pair.rid}`,
                left: pair.lid ? l.get(pair.lid) : undefined,
                right: pair.rid ? r.get(pair.rid) : undefined,
                ...(pair.matched ? { matchedBy: pair.matched } : {}),
                ...(pair.lid && pair.rid ? { inputChanged: canonicalJson(l.get(pair.lid)?.trace.input ?? null) !== canonicalJson(r.get(pair.rid)?.trace.input ?? null), referenceChanged: canonicalJson(l.get(pair.lid)?.expectedOutput ?? null) !== canonicalJson(r.get(pair.rid)?.expectedOutput ?? null) } : {}),
              }))
              return { ...page, pairs, left, right, configurationChanges: evalConfigurationChanges(left, right) }
            })
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        )
      })
    )
  }

  getEvalRun(
    id: string,
    options: EvalReadOptions = {}
  ): TracerEffect<EvalRunDetail> {
    return tracerEffect(() =>
      this.read((service) =>
        fitEvalPage(options.limit ?? 50, (limit) =>
          service.getEvalRunUnsafe(id, { ...options, limit })
        )
      )
    )
  }

  getEvalRunTarget(
    id: string,
    targetId: string
  ): TracerEffect<NonNullable<EvalRunDetail["rows"]>[number]> {
    return tracerEffect(() =>
      this.read(async (service) => {
        const run = await service.getEvalRunUnsafe(id, {}, [targetId])
        const row = run.rows?.[0]
        if (!row) throw notFound("Eval target", targetId)
        return row
      })
    )
  }

  createSavedView(input: CreateSavedViewInput): TracerEffect<SavedView> {
    return tracerEffect(() => this.createSavedViewUnsafe(input))
  }

  listSavedViews(options: ListOptions = {}): TracerEffect<{
    items: SavedView[]
    nextCursor: string | null
    total?: number
  }> {
    return tracerEffect(() =>
      this.read((service) => service.listSavedViewsUnsafe(options))
    )
  }

  getSavedView(id: string): TracerEffect<SavedView> {
    return tracerEffect(() =>
      this.read((service) => service.getSavedViewUnsafe(id))
    )
  }

  patchSavedView(
    id: string,
    input: PatchSavedViewInput
  ): TracerEffect<SavedView> {
    return tracerEffect(() => this.patchSavedViewUnsafe(id, input))
  }

  deleteSavedView(id: string): TracerEffect<{ id: string }> {
    return tracerEffect(() => this.deleteSavedViewUnsafe(id))
  }

  getSavedViewData(
    id: string,
    query: SavedViewDataQuery = {}
  ): TracerEffect<SavedViewData> {
    return tracerEffect(() =>
      this.read((service) => service.getSavedViewDataUnsafe(id, query))
    )
  }

  getSemanticMetricsMetadata(): TracerEffect<SemanticCatalogMetadata> {
    return Effect.mapError(
      this.semanticQueryService.metadata(),
      semanticErrorToTracerError
    )
  }

  batchSemanticMetrics(input: unknown): TracerEffect<SemanticResult[]> {
    return Effect.mapError(
      this.semanticQueryService.batch(input),
      semanticErrorToTracerError
    )
  }

  querySemanticMetrics(input: unknown): TracerEffect<SemanticResult> {
    return Effect.mapError(
      this.semanticQueryService.query(input),
      semanticErrorToTracerError
    )
  }

  createDemo(): TracerEffect<CreateDemoResponse> {
    return tracerEffect(() => this.createDemoUnsafe())
  }

  private async createSessionUnsafe(
    input: CreateSessionInput
  ): Promise<Session> {
    const timestamp = now()
    const id = input.id ?? makeId("ses")
    await this.database.insert(sessions).values({
      attributesJson: JSON.stringify(input.attributes ?? {}),
      createdAt: timestamp,
      id,
      name: input.name ?? null,
      projectId: this.projectId,
      updatedAt: timestamp,
    })
    return {
      attributes: input.attributes ?? {},
      createdAt: timestamp,
      id,
      name: input.name ?? null,
      traceCount: 0,
      updatedAt: timestamp,
    }
  }

  private async listSessionsUnsafe(options: ListOptions) {
    const relation = sql`select id, name, attributes_json as metadata, attributes_json as attributes,
      created_at as "createdAt", updated_at as "updatedAt",
      (select count(*) from traces t where t.project_id = ${this.projectId} and t.session_id = sessions.id) as "traceCount"
      from sessions where project_id = ${this.projectId}`
    const fields = {
      id: { value: sql`id`, type: "string" as const },
      name: { value: sql`name`, type: "string" as const },
      metadata: { value: sql`metadata`, type: "json" as const },
      attributes: { value: sql`attributes`, type: "json" as const },
      createdAt: { value: sql`"createdAt"`, type: "date" as const },
      updatedAt: { value: sql`"updatedAt"`, type: "date" as const },
      traceCount: { value: sql`"traceCount"`, type: "number" as const },
    }
    const filter = collectionSqlFilter("sessions", options.filter, fields)
    const page = await collectionSqlPage<Session & { attributes: string }>(
      this.database,
      sql`select * from (${relation}) summaries where ${filter}`,
      options,
      "updatedAt"
    )
    return {
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        attributes: fromObjectJson(row.attributes),
        traceCount: Number(row.traceCount),
      })),
    }
  }

  private async getSessionUnsafe(id: string): Promise<SessionDetail> {
    const [row] = await this.database
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, this.projectId), eq(sessions.id, id)))
      .limit(1)
    if (!row) {
      throw notFound("Session", id)
    }
    const page = await this.listTracesUnsafe({
      sessionId: id,
      limit: 50,
      includeTotal: true,
    })
    return {
      attributes: fromObjectJson(row.attributesJson),
      createdAt: row.createdAt,
      id: row.id,
      name: row.name,
      traceCount: page.total!,
      traces: page.items,
      nextCursor: page.nextCursor,
      updatedAt: row.updatedAt,
    }
  }

  private async createTraceUnsafe(
    input: CreateTraceInput
  ): Promise<TraceDetail> {
    if (!input.name && !input.operation) {
      throw validation("A trace needs either name or operation.")
    }
    if (input.sessionId) {
      await this.assertSessionExists(input.sessionId)
    }

    const group = readGroup(input.group)
    const timestamp = now()
    const traceId = input.id ?? makeId("tr")
    const startedAt = input.startedAt ?? timestamp
    const traceLifecycle = lifecycle(input.status, input.endedAt)
    const normalizedSpans = (input.spans ?? []).map((span) => {
      const spanGroup = readGroup(span.group)
      const spanStartedAt = span.startedAt ?? startedAt
      const spanLifecycle = lifecycle(span.status, span.endedAt)
      return {
        attributesJson: JSON.stringify(span.attributes ?? {}),
        endedAt: spanLifecycle.endedAt,
        id: span.id ?? makeId("sp"),
        inputJson: toJson(span.input),
        kind: span.kind ?? "custom",
        groupType: spanGroup?.type ?? null,
        groupName: spanGroup?.name ?? null,
        groupVersion: spanGroup?.version ?? null,
        name: span.name,
        outputJson: toJson(span.output),
        parentId: span.parentId ?? null,
        startedAt: spanStartedAt,
        status: spanLifecycle.status,
        traceId,
      }
    })
    this.assertSpanParentGraph(normalizedSpans, true)

    await this.database.transaction(async (transaction) => {
      await transaction.insert(traces).values({
        groupType: group?.type ?? null,
        groupName: group?.name ?? null,
        groupVersion: group?.version ?? null,
        attributesJson: JSON.stringify(input.attributes ?? {}),
        endedAt: traceLifecycle.endedAt,
        id: traceId,
        inputJson: toJson(input.input),
        name: input.name ?? input.operation!,
        operation: input.operation ?? input.name!,
        outputJson: toJson(input.output),
        projectId: this.projectId,
        sessionId: input.sessionId ?? null,
        startedAt,
        status: traceLifecycle.status,
      })
      if (normalizedSpans.length > 0) {
        await transaction.insert(spans).values(
          normalizedSpans.map((span) => ({
            ...span,
            projectId: this.projectId,
          }))
        )
      }
      if (input.sessionId) {
        await transaction
          .update(sessions)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(sessions.projectId, this.projectId),
              eq(sessions.id, input.sessionId)
            )
          )
      }
    })

    return this.getTraceUnsafe(traceId)
  }

  private async listTracesUnsafe(
    options: ListOptions & { sessionId?: string | null; datasetItemId?: string }
  ) {
    const { filter, hasFullText } = (() => {
      try {
        const clauses = traceExpressionFilters(
          options.filter ?? "",
          "traces",
          Date.now()
        )
        const isGroup = (f: (typeof clauses)[number]) =>
          "member" in f &&
          [
            "traces.parent.groupType",
            "traces.parent.groupName",
            "traces.parent.groupVersion",
          ].includes(f.member)
        const groups = clauses.filter(isGroup)
        // Full-text predicates include every descendant span before paging.
        const rootFields = traceSqlFields("traces")
        const groupFields = Object.fromEntries(
          ["groupType", "groupName", "groupVersion"].map((key) => [
            `traces.parent.${key}`,
            {
              value: sql`${sql.identifier(
                {
                  groupType: "group_type",
                  groupName: "group_name",
                  groupVersion: "group_version",
                }[key]!
              )}`,
              type: "string" as const,
              caseSensitive: true,
            },
          ])
        )
        const filter = sql`${semanticSqlFilters(
          clauses.filter((f) => !isGroup(f)),
          rootFields
        )}
          and ${
            groups.length
              ? sql`${traces.id} in (
            with matched as materialized (select distinct trace_id from trace_group_memberships
              where project_id=${this.projectId} and ${semanticSqlFilters(groups, groupFields)})
            select trace_id from matched)`
              : sql`true`
          }`
        return {
          filter,
          hasFullText: clauses.some(
            (clause) =>
              "member" in clause && clause.member === "traces.parent.fullText"
          ),
        }
      } catch (error) {
        throw validation(
          error instanceof Error ? error.message : "Invalid trace filter."
        )
      }
    })()
    const where = and(
      eq(traces.projectId, this.projectId),
      filter,
      options.sessionId ? eq(traces.sessionId, options.sessionId) : undefined,
      options.datasetItemId
        ? sql`exists(select 1 from eval_run_targets t
            where t.project_id=${this.projectId} and t.trace_id=${traces.id}
              and coalesce(t.dataset_item_id,${safeJson(sql`t.snapshot_json`)} #>> '{datasetItem,id}')=${options.datasetItemId})`
        : undefined
    )!
    const limit = Math.max(
      1,
      Math.min(options.limit ?? DEFAULT_LIST_LIMIT, 200)
    )
    // Count, cursor validation and page read must see the same collection.
    const page = await this.database.transaction(
      async (tx) => {
        let totals: { total: number } | undefined
        let pageWhere = where
        if (hasFullText) {
          const matches = await traceSearchPageIds(tx, where, {
            ...options,
            limit,
          })
          if (matches.total !== undefined) totals = { total: matches.total }
          pageWhere = and(
            eq(traces.projectId, this.projectId),
            inArray(traces.id, matches.ids)
          )!
        } else {
          if (options.includeTotal) {
            const [countRow] = await tx
              .select({ total: count() })
              .from(traces)
              .where(where)
            totals = countRow
          }
          let after
          if (options.cursor) {
            const [cursor] = await tx
              .select({ startedAt: traces.startedAtMs, id: traces.id })
              .from(traces)
              .where(and(where, eq(traces.id, options.cursor)))
              .limit(1)
            if (!cursor)
              throw validation(
                "cursor does not identify a row in this collection."
              )
            after =
              cursor.startedAt === null
                ? sql`(${traces.startedAtMs} is null and ${traces.id} < ${cursor.id}) or ${traces.startedAtMs} is not null`
                : sql`(${traces.startedAtMs}, ${traces.id}) < (${cursor.startedAt}, ${cursor.id})`
          }
          pageWhere = and(where, after)!
        }
        await assertRelationBytes(
          tx as unknown as TracerDatabase,
          sql`select * from ${traces} where ${pageWhere} order by ${traces.startedAtMs} desc, ${traces.id} desc limit ${limit + 1}`
        )
        const rows = await tx
          .select()
          .from(traces)
          .where(pageWhere)
          .orderBy(desc(traces.startedAtMs), desc(traces.id))
          .limit(limit + 1)
        const stats = await this.spanStatsByTraceId(
          rows.slice(0, limit).map((row) => row.id),
          tx
        )
        const items = rows.slice(0, limit).map((row) => ({
          ...toTraceSummary(row),
          spanStats: stats.get(row.id) ?? emptySpanStats(),
        }))
        return {
          items,
          ...(totals ? { total: totals.total } : {}),
          nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" }
    )
    return page
  }

  /** One aggregate row per visible trace, on the collection snapshot. */
  private async spanStatsByTraceId(
    traceIds: string[],
    database: Pick<TracerDatabase, "select"> = this.database
  ) {
    if (!traceIds.length) return new Map<string, TraceSpanStats>()
    const rows = await database
      .select({
        traceId: spans.traceId,
        spanCount: count(),
        llmCalls:
          sql<number>`count(*) filter(where ${spans.kind} = 'llm')`.mapWith(
            Number
          ),
        toolCalls:
          sql<number>`count(*) filter(where ${spans.kind} = 'tool')`.mapWith(
            Number
          ),
        errorCount:
          sql<number>`count(*) filter(where ${spans.status} = 'errored')`.mapWith(
            Number
          ),
        llmDurationMs: sql<
          number | null
        >`sum(case when ${spans.kind} = 'llm' and ${spans.status} in ('completed','errored','cancelled') and ${spans.endedAtMs} >= ${spans.startedAtMs} then ${spans.endedAtMs} - ${spans.startedAtMs} end)`.mapWith(
          Number
        ),
      })
      .from(spans)
      .where(
        and(
          eq(spans.projectId, this.projectId),
          inArray(spans.traceId, traceIds)
        )
      )
      .groupBy(spans.traceId)
    return new Map(rows.map(({ traceId, ...stats }) => [traceId, stats]))
  }

  private async getTraceUnsafe(
    id: string,
    page?: ListOptions
  ): Promise<TraceDetail> {
    await assertRelationBytes(
      this.database,
      sql`select * from ${traces} where ${traces.projectId}=${this.projectId} and ${traces.id}=${id}`
    )
    const [row] = await this.database
      .select()
      .from(traces)
      .where(and(eq(traces.projectId, this.projectId), eq(traces.id, id)))
      .limit(1)
    if (!row) {
      throw notFound("Trace", id)
    }
    if (!page)
      await assertRelationBytes(
        this.database,
        sql`select * from ${spans} where ${spans.projectId}=${this.projectId} and ${spans.traceId}=${id}`
      )
    if (!page)
      await assertRelationBytes(
        this.database,
        this.traceScoreRelation(id)
      )
    if (page)
      await assertRelationBytes(
        this.database,
        sql`select * from ${spans} where ${spans.projectId}=${this.projectId} and ${spans.traceId}=${id} order by ${spans.startedAt},${spans.id} limit ${(page.limit ?? 100) + 1}`
      )
    const spanQuery = this.database
      .select()
      .from(spans)
      .where(and(eq(spans.projectId, this.projectId), eq(spans.traceId, id)))
      .orderBy(spans.startedAt, spans.id)
      .$dynamic()
    const scoreQuery = sql`select * from (${this.traceScoreRelation(id)}) score_rows order by "createdAt" desc, id desc ${page ? sql`limit 101` : sql``}`
    const [spanRows, scoreResult] = await Promise.all([
      page ? spanQuery.limit((page.limit ?? 100) + 1) : spanQuery,
      this.database.execute(scoreQuery),
    ])
    const scoreRows = scoreResult.rows as StoredTraceScore[]
    const traceScores = await this.hydrateTraceScores(
      page ? scoreRows.slice(0, 100) : scoreRows
    )
    return {
      ...toTraceSummary(row),
      scores: traceScores,
      nextScoreCursor: page && scoreRows.length > 100 ? scoreRows[99].id : null,
      spanStats:
        (await this.spanStatsByTraceId([id])).get(id) ?? emptySpanStats(),
      spans: (page ? spanRows.slice(0, page.limit ?? 100) : spanRows).map(
        toSpan
      ),
      nextSpanCursor:
        page && spanRows.length > (page.limit ?? 100)
          ? spanRows[(page.limit ?? 100) - 1].id
          : null,
    }
  }

  private traceScoreRelation(id: string) {
    return sql`select id, project_id as "projectId", trace_id as "traceId", evaluator_id as "evaluatorId", eval_result_id as "evalResultId", name, value, status, created_at as "createdAt", external_json as external, null::jsonb as review
      from scores where project_id=${this.projectId} and trace_id=${id}
      union all select s.id, s.project_id, s.trace_id, coalesce(s.scorer_id,''), '', s.name, s.value, 'ok', s.updated_at, null::jsonb,
        jsonb_build_object('sessionId', i.session_id, 'sessionNumber', r.number, 'reviewerId', s.reviewer_id, 'reviewerName', coalesce(s.edited_by_json->'principal'->>'name',s.provenance_json->'principal'->>'name',u.name), 'source', s.source, 'provenance',s.provenance_json, 'editedBy',s.edited_by_json, 'comment', s.comment, 'scorerRevision', s.scorer_revision, 'definition', s.definition_json, 'value', s.human_value)
      from review_scores s join review_items i on i.project_id=s.project_id and i.id=s.item_id
      join review_sessions r on r.project_id=i.project_id and r.id=i.session_id
      left join "user" u on u.id=s.reviewer_id where s.project_id=${this.projectId} and s.trace_id=${id} and s.human_value <> 'null'::jsonb`
  }

  private async hydrateTraceScores(scoreRows: StoredTraceScore[]) {
    const nativeScores = scoreRows.filter(score => !score.review && !score.external)
    const evaluatorIds = [
      ...new Set(nativeScores.flatMap(score => score.evaluatorId ? [score.evaluatorId] : [])),
    ]
    const resultIds = [
      ...new Set(nativeScores.flatMap(score => score.evalResultId ? [score.evalResultId] : [])),
    ]
    const [evaluatorRows, resultRows] = await Promise.all([
      evaluatorIds.length
        ? this.database
            .select()
            .from(evaluators)
            .where(
              and(
                eq(evaluators.projectId, this.projectId),
                inArray(evaluators.id, evaluatorIds)
              )
            )
        : [],
      resultIds.length
        ? this.database
            .select()
            .from(evalResults)
            .where(
              and(
                eq(evalResults.projectId, this.projectId),
                inArray(evalResults.id, resultIds)
              )
            )
        : [],
    ])
    const evaluatorNames = new Map(
      evaluatorRows.map((evaluator) => [evaluator.id, evaluator.name])
    )
    const resultsById = new Map(resultRows.map((result) => [result.id, result]))
    const detailedResults = await this.getEvalResultsForRun(
      undefined,
      resultIds
    )
    const detailsById = new Map(
      detailedResults.map((result) => [result.id, result])
    )
    const traceScores: (TraceScore & { id: string })[] = scoreRows.map(
      (score) => score.review ? {
        id: score.id, evaluatorId: null, evaluatorName: score.name,
        valueLabel: humanScoreValueLabel(score.review.definition, score.review.value),
        evalResultId: null, evalRunId: null, name: score.name, score: score.value, status: "ok",
        reasoning: score.review.comment, evaluatorVersion: score.review.scorerRevision ?? undefined,
        metadata: { source: score.review.source, label: score.review.provenance?.label ?? (score.review.source === "human" ? "Human-reviewed" : "AI-labelled"), humanVerified: score.review.source === "human", provenance: score.review.provenance ?? null, editedBy: score.review.editedBy, reviewSessionId: score.review.sessionId, reviewSessionNumber: score.review.sessionNumber, reviewerId: score.review.reviewerId, reviewerName: score.review.reviewerName },
      } : score.external ? {
        id: score.id, evaluatorId: null, evaluatorName: null,
        evalResultId: null, evalRunId: null,
        name: score.name, score: score.value, status: "ok",
        valueLabel: String(score.external.data.value),
        reasoning: score.external.comment,
        metadata: score.external.metadata,
        external: score.external,
      } : ({
        ...detailsById.get(score.evalResultId ?? ""),
        id: score.id,
        evaluatorId: score.evaluatorId,
        evaluatorName:
          detailsById.get(score.evalResultId ?? "")?.evaluatorName ??
          evaluatorNames.get(score.evaluatorId ?? "") ??
          null,
        evalResultId: score.evalResultId,
        evalRunId: resultsById.get(score.evalResultId ?? "")?.runId ?? null,
        name: evaluatorNames.get(score.evaluatorId ?? "") ?? "Score",
        score: score.value,
        status:
          score.status === "ok"
            ? "ok"
            : score.status === "empty"
              ? "empty"
              : "error",
      })
    )
    return traceScores
  }

  private async listTraceScoresUnsafe(id: string, options: ListOptions = {}) {
    await this.assertTraceExists(id)
    const page = await collectionSqlPage<StoredTraceScore>(
      this.database,
      this.traceScoreRelation(id),
      options,
      "createdAt"
    )
    return { ...page, items: await this.hydrateTraceScores(page.items) }
  }

  private async patchTraceUnsafe(
    id: string,
    input: PatchTraceInput
  ): Promise<TraceDetail> {
    const [current] = await this.database
      .select()
      .from(traces)
      .where(and(eq(traces.projectId, this.projectId), eq(traces.id, id)))
      .limit(1)
    if (!current) {
      throw notFound("Trace", id)
    }
    const nextLifecycle = lifecycle(
      input.status,
      input.endedAt,
      current.status as TraceStatus,
      current.endedAt
    )
    const next = {
      attributesJson:
        input.attributes === undefined
          ? current.attributesJson
          : JSON.stringify(input.attributes),
      endedAt: nextLifecycle.endedAt,
      inputJson:
        input.input === undefined ? current.inputJson : toJson(input.input),
      name: input.name ?? current.name,
      operation: input.operation ?? current.operation,
      outputJson:
        input.output === undefined ? current.outputJson : toJson(input.output),
      status: nextLifecycle.status,
    }
    await this.database
      .update(traces)
      .set(next)
      .where(and(eq(traces.projectId, this.projectId), eq(traces.id, id)))
    return this.getTraceUnsafe(id)
  }

  private async createSpanUnsafe(
    traceId: string,
    input: CreateSpanInput
  ): Promise<Span> {
    const group = readGroup(input.group)
    await this.assertTraceExists(traceId)
    const spanId = input.id ?? makeId("sp")
    const existingRows = await this.spanParentRows(traceId)
    if (existingRows.some((row) => row.id === spanId)) {
      throw new TracerError("CONFLICT", `Span '${spanId}' already exists.`, {
        details: { id: spanId },
      })
    }
    if (input.parentId) {
      const [parent] = await this.database
        .select({ id: spans.id })
        .from(spans)
        .where(
          and(
            eq(spans.projectId, this.projectId),
            eq(spans.id, input.parentId),
            eq(spans.traceId, traceId)
          )
        )
        .limit(1)
      if (!parent) {
        throw validation("A span parent must belong to the same trace.", {
          parentId: input.parentId,
          traceId,
        })
      }
    }
    const timestamp = now()
    const spanLifecycle = lifecycle(input.status, input.endedAt)
    this.assertSpanParentGraph(
      [...existingRows, { id: spanId, parentId: input.parentId ?? null }],
      true
    )
    await this.database.insert(spans).values({
      attributesJson: JSON.stringify(input.attributes ?? {}),
      endedAt: spanLifecycle.endedAt,
      id: spanId,
      inputJson: toJson(input.input),
      kind: input.kind ?? "custom",
      groupType: group?.type ?? null,
      groupName: group?.name ?? null,
      groupVersion: group?.version ?? null,
      name: input.name,
      outputJson: toJson(input.output),
      projectId: this.projectId,
      parentId: input.parentId ?? null,
      startedAt: input.startedAt ?? timestamp,
      status: spanLifecycle.status,
      traceId,
    })
    const [row] = await this.database
      .select()
      .from(spans)
      .where(and(eq(spans.projectId, this.projectId), eq(spans.id, spanId)))
      .limit(1)
    if (!row) {
      throw new TracerError("INTERNAL_ERROR", "Span was not persisted.")
    }
    return toSpan(row)
  }

  private async patchSpanUnsafe(
    id: string,
    input: PatchSpanInput
  ): Promise<Span> {
    const [current] = await this.database
      .select()
      .from(spans)
      .where(and(eq(spans.projectId, this.projectId), eq(spans.id, id)))
      .limit(1)
    if (!current) {
      throw notFound("Span", id)
    }
    if (input.parentId && input.parentId !== current.parentId) {
      const [parent] = await this.database
        .select({ id: spans.id })
        .from(spans)
        .where(
          and(
            eq(spans.projectId, this.projectId),
            eq(spans.id, input.parentId),
            eq(spans.traceId, current.traceId)
          )
        )
        .limit(1)
      if (!parent) {
        throw validation("A span parent must belong to the same trace.", {
          parentId: input.parentId,
        })
      }
    }
    const nextParentId =
      input.parentId === undefined ? current.parentId : input.parentId
    const parentRows = await this.spanParentRows(current.traceId)
    this.assertSpanParentGraph(
      parentRows.map((row) =>
        row.id === id ? { ...row, parentId: nextParentId } : row
      ),
      true
    )
    const spanLifecycle = lifecycle(
      input.status,
      input.endedAt,
      current.status as SpanStatus,
      current.endedAt
    )
    await this.database
      .update(spans)
      .set({
        attributesJson:
          input.attributes === undefined
            ? current.attributesJson
            : JSON.stringify(input.attributes),
        endedAt: spanLifecycle.endedAt,
        inputJson:
          input.input === undefined ? current.inputJson : toJson(input.input),
        kind: input.kind ?? current.kind,
        name: input.name ?? current.name,
        outputJson:
          input.output === undefined
            ? current.outputJson
            : toJson(input.output),
        parentId: nextParentId,
        status: spanLifecycle.status,
      })
      .where(and(eq(spans.projectId, this.projectId), eq(spans.id, id)))
    const [row] = await this.database
      .select()
      .from(spans)
      .where(and(eq(spans.projectId, this.projectId), eq(spans.id, id)))
      .limit(1)
    if (!row) {
      throw new TracerError("INTERNAL_ERROR", "Span update was not persisted.")
    }
    return toSpan(row)
  }

  private async createDatasetUnsafe(
    input: CreateDatasetInput
  ): Promise<Dataset> {
    return createDatasetInLibrary(this.database, input)
  }

  private async listDatasetsUnsafe(options: ListOptions) {
    return collectionSqlPage<Dataset>(
      this.database,
      sql`select id,name,description,metadata_json::jsonb as metadata,field_schemas_json::jsonb as "fieldSchemas",version_id as "versionId",revision,created_at as "createdAt",updated_at as "updatedAt",
      (select count(*)::integer from dataset_items i where i.project_id = ${this.projectId} and i.dataset_id = datasets.id) as "itemCount"
      from datasets where project_id = ${this.projectId} ${options.filter ? sql`and strpos(lower(name || ' ' || coalesce(description,'')),lower(${options.filter})) > 0` : sql``}`,
      options,
      "updatedAt"
    )
  }

  private async getDatasetUnsafe(id: string, includeItems = true): Promise<DatasetDetail> {
    const [row] = await this.database
      .select()
      .from(datasets)
      .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, id)))
      .limit(1)
    if (!row) {
      throw notFound("Dataset", id)
    }
    if (!includeItems) {
      const [total] = await this.database.select({ count: count() }).from(datasetItems)
        .where(and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.datasetId, id)))
      return { ...toDataset(row, total.count), items: [] }
    }
    const page = await this.listDatasetItemsUnsafe(id, {
      limit: 50,
      includeTotal: true,
    })
    return {
      ...toDataset(row, page.total!),
      items: page.items,
      nextCursor: page.nextCursor,
    }
  }

  private async getDatasetArtifactUnsafe(id: string): Promise<DatasetDetail> {
    const [row] = await this.database
      .select()
      .from(datasets)
      .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, id)))
      .limit(1)
    if (!row) throw notFound("Dataset", id)
    await assertRelationBytes(
      this.database,
      sql`select * from ${datasetItems} where ${datasetItems.projectId}=${this.projectId} and ${datasetItems.datasetId}=${id}`
    )
    const items = await this.database
      .select()
      .from(datasetItems)
      .where(
        and(
          eq(datasetItems.projectId, this.projectId),
          eq(datasetItems.datasetId, id)
        )
      )
      .orderBy(datasetItems.createdAt, datasetItems.id)
    return { ...toDataset(row, items.length), items: items.map(toDatasetItem) }
  }

  private async listDatasetItemsUnsafe(id: string, options: ListOptions & { preview?: boolean }) {
    const [dataset] = await this.database
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, id)))
      .limit(1)
    if (!dataset) throw notFound("Dataset", id)
    const predicate = collectionSqlFilter("datasetItems", options.filter, {
      id: { value: sql`id`, type: "string" },
      input: { value: sql`input_json`, type: "json" },
      expectedOutput: { value: sql`expected_output_json`, type: "json" },
      metadata: { value: sql`metadata_json`, type: "json" },
      sourceTraceId: { value: sql`source_trace_id`, type: "string" },
      sourceSpanId: { value: sql`source_span_id`, type: "string" },
      createdAt: { value: sql`created_at`, type: "date" },
      updatedAt: { value: sql`updated_at`, type: "date" },
    })
    const page = await fitEvalPage(options.limit ?? 50, (limit) => collectionSqlPage<DatasetItemRow & Pick<DatasetItemPreview, "omittedFields">>(
      this.database,
      sql`select ${datasetItemProjection(options.preview ?? false)} from dataset_items where project_id=${this.projectId} and dataset_id=${id} and ${predicate}`,
      { ...options, limit },
      "createdAt",
      true
    ))
    return { ...page, items: page.items.map(row => ({ ...toDatasetItem(row), ...(row.omittedFields && Object.keys(row.omittedFields).length ? { omittedFields: row.omittedFields } : {}) })) }
  }

  private async patchDatasetUnsafe(
    id: string,
    input: PatchDatasetInput
  ): Promise<Dataset> {
    return patchDatasetInLibrary(this.database, id, input)
  }

  private async createDatasetItemUnsafe(
    datasetId: string,
    input: CreateDatasetItemInput
  ): Promise<DatasetItem> {
    if (input.sourceTraceId) {
      await this.assertTraceExists(input.sourceTraceId)
    }
    if (input.sourceSpanId && !input.sourceTraceId) throw validation("sourceSpanId requires sourceTraceId.")
    const evidence = input.sourceSpanId ? await captureSpanEvidence(this.database, input.sourceTraceId!, input.sourceSpanId) : null
    const timestamp = now()
    const id = input.id ?? makeId("ditem")
    return this.database.transaction(async (transaction) => {
      const [dataset] = await transaction.select().from(datasets)
        .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, datasetId))).for("update")
      if (!dataset) throw notFound("Dataset", datasetId)
      validateDatasetItem(dataset.fieldSchemasJson, input)
      const [existing] = await transaction.select().from(datasetItems)
        .where(and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.id, id)))
      if (existing) {
        if (existing.datasetId === datasetId && canonicalJson({
          input: input.input, expectedOutput: input.expectedOutput ?? null,
          metadata: input.metadata ?? {}, sourceTraceId: input.sourceTraceId ?? null, sourceSpanId: input.sourceSpanId ?? null,
        }) === canonicalJson({
          input: fromJson(existing.inputJson), expectedOutput: fromJson(existing.expectedOutputJson),
          metadata: fromObjectJson(existing.metadataJson), sourceTraceId: existing.sourceTraceId, sourceSpanId: existing.sourceSpanId,
        })) return { ...toDatasetItem(existing), datasetRevision: dataset.revision, datasetVersionId: dataset.versionId }
        throw new TracerError("CONFLICT", "A different dataset row already uses this ID.")
      }
      const [created] = await transaction.insert(datasetItems).values({
        createdAt: timestamp,
        datasetId,
        expectedOutputJson: toJson(input.expectedOutput),
        id,
        inputJson: JSON.stringify(input.input),
        metadataJson: JSON.stringify(input.metadata ?? {}),
        projectId: this.projectId,
        sourceTraceId: input.sourceTraceId ?? null,
        sourceSpanId: input.sourceSpanId ?? null,
        sourceSpanEvidenceJson: evidence ? JSON.stringify(evidence) : null,
        updatedAt: timestamp,
      }).returning()
      const [revision] = await transaction
        .update(datasets)
        .set({ updatedAt: timestamp })
        .where(
          and(
            eq(datasets.projectId, this.projectId),
            eq(datasets.id, datasetId)
          )
        ).returning({ revision: datasets.revision, versionId: datasets.versionId })
      return { ...toDatasetItem(created), datasetRevision: revision.revision, datasetVersionId: revision.versionId }
    })
  }

  private async patchDatasetItemUnsafe(
    id: string,
    input: PatchDatasetItemInput
  ): Promise<DatasetItem> {
    const [identity] = await this.database.select({ datasetId: datasetItems.datasetId }).from(datasetItems)
      .where(and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.id, id)))
    if (!identity) throw notFound("Dataset item", id)
    if (input.sourceTraceId) await this.assertTraceExists(input.sourceTraceId)
    return this.database.transaction(async (transaction) => {
      // Lock parent first, as bulk writes and schema edits do. Validate the final row in this transaction.
      const [dataset] = await transaction.select().from(datasets)
        .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, identity.datasetId))).for("update")
      if (!dataset) throw notFound("Dataset", identity.datasetId)
      const [current] = await transaction.select().from(datasetItems)
        .where(and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.id, id))).for("update")
      if (!current) throw notFound("Dataset item", id)
      const { expectedVersionId, ...patch } = input
      const next = { ...toDatasetItem(current), ...patch, updatedAt: now() }
      if (next.sourceSpanId && !next.sourceTraceId) throw validation("sourceSpanId requires sourceTraceId; clear both references together.")
      if (next.sourceSpanId !== current.sourceSpanId || next.sourceTraceId !== current.sourceTraceId) {
        next.sourceSpanEvidence = next.sourceSpanId ? await captureSpanEvidence(scopedTracerTransaction(this.database, transaction), next.sourceTraceId!, next.sourceSpanId) : null
      }
      const values = (item: DatasetItem) => ({ input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata, sourceTraceId: item.sourceTraceId, sourceSpanId: item.sourceSpanId, sourceSpanEvidence: item.sourceSpanEvidence })
      if (canonicalJson(values(next)) === canonicalJson(values(toDatasetItem(current)))) return { ...toDatasetItem(current), datasetRevision: dataset.revision, datasetVersionId: dataset.versionId }
      if (expectedVersionId && expectedVersionId !== current.versionId)
        throw new TracerError("CONFLICT", "This row changed in another session. Your draft is kept; review the latest row before retrying.")
      validateDatasetItem(dataset.fieldSchemasJson, next)
      const [updated] = await transaction.update(datasetItems).set({
        inputJson: JSON.stringify(next.input),
        expectedOutputJson: toJson(next.expectedOutput),
        metadataJson: JSON.stringify(next.metadata),
        sourceTraceId: next.sourceTraceId,
        sourceSpanId: next.sourceSpanId,
        sourceSpanEvidenceJson: next.sourceSpanEvidence ? JSON.stringify(next.sourceSpanEvidence) : null,
        updatedAt: next.updatedAt,
      }).where(and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.id, id))).returning()
      const [revision] = await transaction.update(datasets).set({ updatedAt: next.updatedAt })
        .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, current.datasetId)))
        .returning({ revision: datasets.revision, versionId: datasets.versionId })
      return { ...toDatasetItem(updated), datasetRevision: revision.revision, datasetVersionId: revision.versionId }
    })
  }

  private async deleteDatasetItemUnsafe(id: string) {
    const [current] = await this.database
      .select()
      .from(datasetItems)
      .where(
        and(eq(datasetItems.projectId, this.projectId), eq(datasetItems.id, id))
      )
      .limit(1)
    if (!current) {
      throw notFound("Dataset item", id)
    }
    await this.database.transaction(async (transaction) => {
      await transaction.select({ id: datasets.id }).from(datasets)
        .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, current.datasetId))).for("update")
      await transaction
        .delete(datasetItems)
        .where(
          and(
            eq(datasetItems.projectId, this.projectId),
            eq(datasetItems.id, id)
          )
        )
      await transaction
        .update(datasets)
        .set({ updatedAt: now() })
        .where(
          and(
            eq(datasets.projectId, this.projectId),
            eq(datasets.id, current.datasetId)
          )
        )
    })
    return { id }
  }

  private async createEvaluatorUnsafe(
    input: CreateEvaluatorInput
  ): Promise<Evaluator> {
    const timestamp = now()
    const evaluatorId = input.id ?? makeId("evalr")
    const versionId = makeId("evalv")
    await this.database.transaction(async (transaction) => {
      await transaction.insert(evaluators).values({
        activeVersionId: versionId,
        createdAt: timestamp,
        description: input.description ?? null,
        id: evaluatorId,
        name: input.name,
        projectId: this.projectId,
        updatedAt: timestamp,
      })
      await transaction.insert(evaluatorVersions).values({
        code: input.code,
        createdAt: timestamp,
        evaluatorId,
        id: versionId,
        language: input.language,
        projectId: this.projectId,
        version: 1,
      })
    })
    return {
      activeVersion: {
        code: input.code,
        createdAt: timestamp,
        evaluatorId,
        id: versionId,
        language: input.language,
        version: 1,
      },
      createdAt: timestamp,
      description: input.description ?? null,
      id: evaluatorId,
      name: input.name,
      updatedAt: timestamp,
    }
  }

  private async listEvaluatorsUnsafe(options: ListOptions) {
    const page = await collectionSqlPage<Evaluator>(
      this.database,
      sql`select e.id,e.name,e.description,e.created_at as "createdAt",e.updated_at as "updatedAt",
      case when v.id is not null then jsonb_build_object('id',v.id,'evaluatorId',v.evaluator_id,'version',v.version,'language',v.language,'code',v.code,'createdAt',v.created_at) || case when v.config_json is null then '{}'::jsonb else jsonb_build_object('config',v.config_json::jsonb) end end as "activeVersion"
      from evaluators e left join evaluator_versions v on v.project_id=${this.projectId} and v.id=e.active_version_id
      where e.project_id=${this.projectId}`,
      options,
      "updatedAt"
    )
    if (page.items.some((e) => !e.activeVersion))
      throw new TracerError(
        "INTERNAL_ERROR",
        "An evaluator has no active executable version."
      )
    return page
  }

  private async getEvaluatorUnsafe(id: string): Promise<Evaluator> {
    const [row] = await this.database
      .select()
      .from(evaluators)
      .where(
        and(eq(evaluators.projectId, this.projectId), eq(evaluators.id, id))
      )
      .limit(1)
    if (!row) {
      throw notFound("Evaluator", id)
    }
    return this.toEvaluator(row)
  }

  private async patchEvaluatorUnsafe(
    id: string,
    input: PatchEvaluatorInput
  ): Promise<Evaluator> {
    const catalog = await runTracerEffect(this.scorers.get(id))
    if (["llm", "library"].includes(catalog.type) && input.code !== undefined)
      throw validation("Edit LLM and library scorers through the scorer editor.")
    await runTracerEffect(
      this.scorers.save(
        {
          ...catalog,
          ...input,
          description: input.description ?? catalog.description,
          expectedRevision: catalog.revision,
        },
        id
      )
    )
    return this.getEvaluatorUnsafe(id)
  }

  private async createEvalRunUnsafe(
    input: CreateEvalRunInput
  ): Promise<EvalRunDetail> {
    const iteration = await resolveRunIteration(this.database, input)
    input = iteration.input
    let inputOverrides: JsonObject | undefined
    try { inputOverrides = validateInputOverrides(input) } catch (error) {
      throw validation((error as Error).message)
    }
    let promptOverrides
    try { promptOverrides = validatePromptOverrides(input) } catch (error) { throw validation((error as Error).message) }
    const evaluatorIds = uniqueIds(input.evaluatorIds ?? [], "evaluatorIds")
    const singleInvocation = input.mode === "connected" && input.input !== undefined
    if (input.input !== undefined && (!singleInvocation || input.datasetId || input.sourceRunId || input.traceIds?.length))
      throw validation("App input requires connected mode without a dataset, source run or trace selection.")
    if (!singleInvocation && !input.parentRunId && !input.sourceRunId && !input.datasetId && !input.traceIds?.length) {
      throw validation("An eval run needs traceIds, datasetId, or both.")
    }
    if (input.datasetItemIds?.length && !input.datasetId) {
      throw validation("datasetItemIds can only be used with datasetId.")
    }
    const traceIds = input.traceIds ? uniqueIds(input.traceIds, "traceIds") : []
    if (
      input.sourceRunId &&
      (input.mode === "connected" || input.traceIds?.length || input.datasetId)
    )
      throw validation(
        "Re-scoring a saved run cannot also execute an app or select other targets"
      )
    const app =
      input.mode === "connected"
        ? await (this.options.resolveApp ?? resolveApp)(input.appId ?? "")
        : null
    if (app && !singleInvocation && !input.parentRunId && (!input.datasetId || traceIds.length))
      throw validation("Connected runs require a dataset and no traceIds")
    if (input.datasetVersionId && (!input.datasetId || input.sourceRunId))
      throw validation("datasetVersionId requires datasetId and cannot accompany sourceRunId")
    if (input.evaluatorVersionIds && Object.keys(input.evaluatorVersionIds).some((id) => !evaluatorIds.includes(id)))
      throw validation("Version pins must refer to selected evaluators")
    let promptConfig = app ? input.useRecordedVersions && iteration.parent?.prompts && !Object.keys(input.promptOverrides ?? {}).length ? iteration.parent.prompts : await runTracerEffect(this.prompts.freeze(promptOverrides)) : undefined
    if (input.useRecordedVersions && iteration.parent?.prompts && promptConfig) {
      for (const [slug, previous] of Object.entries(iteration.parent.prompts.prompts)) if (promptConfig.prompts[slug]?.id !== previous.id) throw validation(`Recorded prompt ${slug} no longer has the same identity. Select latest explicitly to use its replacement.`)
      const slugs = new Set([...Object.keys(iteration.parent.prompts.prompts), ...Object.keys(input.promptOverrides ?? {})])
      promptConfig.prompts = Object.fromEntries(Object.entries(promptConfig.prompts).filter(([slug]) => slugs.has(slug)))
    }
    const frozenDataset = input.datasetVersionId
      ? await this.agent.snapshotArtifact(input.datasetId!, input.datasetVersionId)
      : null
    const evaluatorRows = await Promise.all(evaluatorIds.map(async (id) => {
      const evaluator = await this.getEvaluatorUnsafe(id)
      const versionId = input.evaluatorVersionIds?.[id]
      return versionId ? { ...evaluator, activeVersion: await this.agent.scorerVersion(id, versionId) } : evaluator
    }))
    let targets: EvalTarget[]
    let sourceApp: JsonValue = null
    if (input.sourceRunId && !app) {
      const source = await this.getEvalRunUnsafe(input.sourceRunId)
      if (source.status === "running")
        throw validation("Wait for the source run to finish")
      sourceApp = source.metadata.app ?? source.metadata.sourceApp ?? null
      inputOverrides = source.metadata.inputOverrides as JsonObject | undefined
      input = { ...input, datasetId: source.datasetId ?? undefined, datasetVersionId: typeof source.metadata.datasetVersionId === "string" ? source.metadata.datasetVersionId : undefined }
      promptConfig = source.metadata?.promptConfig as FrozenPromptConfig | undefined
      await assertRelationBytes(this.database, sql`select snapshot_json from eval_run_targets where project_id=${this.projectId} and run_id=${source.id}`)
      const saved = await this.database
        .select()
        .from(evalRunTargets)
        .where(and(eq(evalRunTargets.projectId, this.projectId), eq(evalRunTargets.runId, source.id)))
        .orderBy(evalRunTargets.ordinal)
      targets = await Promise.all(
        saved.map(async (row) => ({
          ...(row.snapshotJson
            ? (JSON.parse(row.snapshotJson) as EvalTarget)
            : {
                trace: await this.getTraceUnsafe(row.traceId),
                datasetItem: null,
              }),
          datasetItemReference: row.datasetItemId,
        }))
      )
    } else if (app && input.parentRunId) {
      await assertRelationBytes(this.database, sql`select snapshot_json from eval_run_targets where project_id=${this.projectId} and run_id=${input.parentRunId}`)
      const saved = await this.database.select().from(evalRunTargets).where(and(eq(evalRunTargets.projectId, this.projectId), eq(evalRunTargets.runId, input.parentRunId))).orderBy(evalRunTargets.ordinal)
      const previous = saved.map(row => row.snapshotJson ? JSON.parse(row.snapshotJson) as EvalTarget : null)
      if (previous.some(target => !target)) throw validation("This legacy run has no frozen cases; select its dataset explicitly.")
      const inputs = previous.map(target => {
        const value = effectiveEvalInput(target!.datasetItem ? target!.datasetItem.input : target!.trace.input, inputOverrides)
        validateAppInput(app, value)
        return value
      })
      targets = []
      for (const [index, target] of previous.entries()) targets.push({ datasetItem: target!.datasetItem, datasetItemReference: null, trace: await beginInvocation(this, app, inputs[index]) })
      if (typeof iteration.parent?.metadata.datasetVersionId === "string") input.datasetVersionId = iteration.parent.metadata.datasetVersionId
    } else if (app && singleInvocation) {
      validateAppInput(app, input.input)
      targets = [{ datasetItem: null, trace: await beginInvocation(this, app, input.input) }]
    } else if (app) {
      const dataset = frozenDataset ?? await this.getDatasetArtifactUnsafe(input.datasetId!)
      let selectedItems = input.datasetItemIds
      if (input.sourceRunId) {
        await this.assertEvalRunExists(input.sourceRunId)
        const sourceTargets = await this.database
          .select({ id: evalRunTargets.datasetItemId })
          .from(evalRunTargets)
          .where(
            and(
              eq(evalRunTargets.projectId, this.projectId),
              eq(evalRunTargets.runId, input.sourceRunId)
            )
          )
        selectedItems = sourceTargets.flatMap((row) => (row.id ? [row.id] : []))
      }
      const items = dataset.items.filter(
        (item) => !selectedItems || selectedItems.includes(item.id)
      )
      if (selectedItems && items.length !== new Set(selectedItems).size)
        throw validation("Selected items do not belong to this dataset")
      if (items.length > 10_000 || items.length * evaluatorRows.length > 100_000)
        throw validation("Eval runs support at most 10,000 targets and 100,000 results.")
      const effectiveInputs = items.map((item) => {
        try {
          const effectiveInput = effectiveEvalInput(item.input, inputOverrides)
          validateAppInput(app, effectiveInput)
          return effectiveInput
        } catch (error) {
          throw validation(
            `Dataset item ${item.id} effective input is invalid: ${(error as Error).message}`
          )
        }
      })
      targets = []
      for (const [index, item] of items.entries())
        targets.push({
          datasetItem: structuredClone(item),
          ...(frozenDataset ? { datasetItemReference: null } : {}),
          trace: await beginInvocation(this, app, effectiveInputs[index]),
        })
    } else if (frozenDataset) {
      const items = frozenDataset.items.filter((item) => !input.datasetItemIds || input.datasetItemIds.includes(item.id))
      if (input.datasetItemIds && items.length !== new Set(input.datasetItemIds).size)
        throw validation("Selected items do not belong to this dataset snapshot")
      targets = await this.resolveEvalTargets(undefined, undefined, traceIds)
      for (const item of items) {
        if (!item.sourceTraceId) throw validation("Snapshot items need sourceTraceId for trace scoring; use connected mode to execute an app.")
        targets.push({ datasetItem: item, datasetItemReference: null, trace: await this.datasetEvidence(item) })
      }
    } else
      targets = await this.resolveEvalTargets(
        input.datasetId,
        input.datasetItemIds,
        traceIds
      )
    targets = targets.map(target => ({
      ...target,
      ...(!input.sourceRunId && !app ? { attributions: collectEvalAttributions(target.trace) } : {}),
      trace: scorerEvidence(target.trace),
    }))
    if (targets.length === 0) {
      throw validation("This eval run has no trace targets.")
    }
    if (targets.length > 10_000 || targets.length * evaluatorRows.length > 100_000)
      throw validation("Eval runs support at most 10,000 targets and 100,000 results.")
    if (Buffer.byteLength(JSON.stringify(targets)) > READ_MAX_BYTES)
      throw new TracerError("READ_RESULT_TOO_LARGE", "Evaluation evidence exceeds 8 MiB; select fewer targets.")
    for (const target of targets) {
      target.targetId = makeId("ertarget")
    }
    const runId = makeId("erun")
    const createdAt = now()
    // Persist the experiment and its invocation links before executing handlers.
    if (app) for (const target of targets) {
      target.trace = { ...target.trace, attributes: { ...target.trace.attributes, "datool.eval.run.id": runId } }
    }
    await this.database.transaction(async (transaction) => {
      await transaction.insert(evalRuns).values({
        metadataJson: JSON.stringify({
          ...input.metadata,
          parentRunId: input.parentRunId ?? input.sourceRunId ?? null,
          useRecordedVersions: input.useRecordedVersions ?? false,
          ...(iteration.parent ? { configurationChanges: evalConfigurationChanges({ metadata: iteration.parent.metadata, evaluatorVersionIds: iteration.parent.scorerVersions }, { metadata: { app: (app?.definition ?? null) as unknown as JsonValue, sourceApp, promptConfig: promptConfig as unknown as JsonValue ?? null, inputOverrides: inputOverrides ?? {} }, evaluatorVersionIds: Object.fromEntries(evaluatorRows.map(e => [e.id, e.activeVersion.id])) }) } : {}),
          promptConfig: promptConfig ?? null,
          sourceRunId: input.sourceRunId ?? null,
          datasetVersionId: input.datasetVersionId ?? null,
          app: app?.definition ?? null,
          sourceApp,
          mode: app ? "connected" : "evidence",
          // Reserved provenance: caller metadata cannot replace the actual overrides.
          inputOverrides: inputOverrides ?? {},
          concurrency: input.concurrency ?? 4,
        }),
        completedAt: null,
        groupsResolvedAt: targets.every(target => target.attributions !== undefined) ? createdAt : null,
        createdAt,
        datasetId: input.datasetId ?? null,
        id: runId,
        name: input.name ?? null,
        projectId: this.projectId,
        status: "running",
      })
      if (input.agentRequestKey) await transaction.execute(sql`update agent_eval_requests set state='started',run_id=${runId} where project_id=${this.projectId} and request_key=${input.agentRequestKey} and state='starting'`)
      if (app) for (const target of targets) {
        await transaction.update(traces).set({ attributesJson: JSON.stringify(target.trace.attributes) })
          .where(and(eq(traces.projectId, this.projectId), eq(traces.id, target.trace.id)))
      }
      if (evaluatorRows.length) await transaction.insert(evalRunEvaluators).values(
        evaluatorRows.map((evaluator) => ({
          evaluatorId: evaluator.id,
          evaluatorVersionId: evaluator.activeVersion.id,
          id: makeId("ere"),
          projectId: this.projectId,
          runId,
        }))
      )
      await transaction.insert(evalRunTargets).values(
        targets.map((target, ordinal) => ({
          createdAt,
          datasetItemId:
            target.datasetItemReference === undefined
              ? (target.datasetItem?.id ?? null)
              : target.datasetItemReference,
          id: target.targetId!,
          ordinal,
          stage: app ? "queued" : "capturing",
          projectId: this.projectId,
          runId,
          snapshotJson: JSON.stringify(target),
          traceId: target.trace.id,
        }))
      )
      await saveEvalAttributions(scopedTracerTransaction(this.database, transaction), runId,
        targets.flatMap(target => target.attributions ? [{ targetId: target.targetId!, attributions: target.attributions }] : []))
    })

    const execution = this.execution()
    const owner = await execution.claim(runId)
    const execute = () => execution.execute(runId, owner!)
    if ((app && !singleInvocation) || input.background) {
      const initial = await this.getEvalRunUnsafe(runId)
      // Local persistent process only. Startup recovery marks interrupted runs.
      setImmediate(() => {
        void execute().catch(() => {})
      })
      return initial
    }
    await execute()
    return this.getEvalRunUnsafe(runId)
  }

  private async listEvalRunsUnsafe(options: ListOptions) {
    return listEvalSummaries(this.database, this.projectId, options)
  }

  private async getEvalRunUnsafe(
    id: string,
    options: EvalReadOptions = {},
    selectedTargetIds?: string[]
  ): Promise<EvalRunDetail> {
    const [run] = await this.database
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.projectId, this.projectId), eq(evalRuns.id, id)))
      .limit(1)
    if (!run) {
      throw notFound("Eval run", id)
    }
    const summaryPage = await listEvalSummaries(this.database, this.projectId, {
      filter: `id = ${JSON.stringify(id)}`,
      limit: 1,
    })
    const summary = summaryPage.items[0]
    const includeEvidence = options.includeEvidence !== false
    // Project before the SQL byte guard so frozen spans never enter a table read.
    const snapshotColumn = includeEvidence
      ? sql`snapshot_json`
      : sql`(snapshot_json::jsonb #- '{trace,spans}' #- '{trace,scores}' #- '{datasetItem,sourceSpanEvidence}' #- '{datasetItem,input}' #- '{datasetItem,metadata}')::text`
    const targetPage = await collectionSqlPage<
      typeof evalRunTargets.$inferSelect
    >(
      this.database,
      sql`select id,run_id as "runId",trace_id as "traceId",dataset_item_id as "datasetItemId",${snapshotColumn} as "snapshotJson",stage,execution_error as "executionError",ordinal from eval_run_targets where project_id=${this.projectId} and run_id=${id}
      ${
        selectedTargetIds
          ? selectedTargetIds.length
            ? sql`and id in (${sql.join(
                selectedTargetIds.map((id) => sql`${id}`),
                sql`, `
              )})`
            : sql`and false`
          : sql``
      }`,
      { ...options, limit: selectedTargetIds ? 100 : (options.limit ?? 50) },
      "ordinal",
      true
    )
    const targets = targetPage.items
    const progress = await getEvalProgress(
      this.database, this.projectId, id, targets.map(target => target.id)
    )
    const results = targets.length
      ? await this.getEvalResultsForRun(
          id,
          undefined,
          targets.map((t) => t.id)
        )
      : []
    const traceIds = [...new Set(targets.map((target) => target.traceId))]
    const itemIds = targets.flatMap((target) =>
      target.datasetItemId ? [target.datasetItemId] : []
    )
    const [traceRows, items, scorerSpans] = await Promise.all([
      traceIds.length
        ? this.database
            .select()
            .from(traces)
            .where(
              and(
                eq(traces.projectId, this.projectId),
                inArray(traces.id, traceIds)
              )
            )
        : [],
      itemIds.length
        ? this.database
            .select()
            .from(datasetItems)
            .where(
              and(
                eq(datasetItems.projectId, this.projectId),
                inArray(datasetItems.id, itemIds)
              )
            )
        : [],
      includeEvidence && targets.length
        ? this.database.select().from(spans).where(and(
            eq(spans.projectId, this.projectId),
            inArray(spans.traceId, traceIds),
            sql`${spans.attributesJson}::jsonb ->> 'eval.run_id' = ${id}`,
            sql`${spans.attributesJson}::jsonb ->> 'eval.target_id' in (${sql.join(targets.map(target => sql`${target.id}`), sql`, `)})`,
          )).orderBy(spans.startedAt, spans.id)
        : [],
    ])
    const rows = targets.flatMap((target) => {
      const trace = traceRows.find((trace) => trace.id === target.traceId)
      if (!trace) return []
      const item = items.find((item) => item.id === target.datasetItemId)
      const snapshot = target.snapshotJson
        ? (JSON.parse(target.snapshotJson) as EvalTarget)
        : null
      const targetResults = results.filter(
        (result) =>
          result.metadata.evalTargetId
            ? result.metadata.evalTargetId === target.id
            : result.traceId === target.traceId && result.datasetItemId === target.datasetItemId
      )
      // Evidence stays frozen; execution spans and results are attached only for inspection.
      const scoringTrace = includeEvidence && snapshot
        ? {
            ...snapshot.trace,
            durationMs: durationMs(snapshot.trace.startedAt, snapshot.trace.endedAt),
            spans: [
              ...snapshot.trace.spans,
              ...scorerSpans.filter(span => JSON.parse(span.attributesJson)["eval.target_id"] === target.id).map(toSpan),
            ],
            scores: targetResults.map((result): TraceScore => ({
              ...result,
              evaluatorId: result.evaluatorId,
              evaluatorName: result.evaluatorName,
              evalResultId: result.id,
              evalRunId: result.runId,
              name: result.evaluatorName,
              score: result.score,
              status:
                result.status === "error"
                  ? "error"
                  : result.score === null
                    ? "empty"
                    : "ok",
            })),
          }
        : undefined
      // TraceSummary never includes spans/scores; those belong to scoringTrace.
      const frozenSummary: Partial<TraceDetail> = { ...snapshot?.trace }
      delete frozenSummary.spans
      delete frozenSummary.scores
      return [
        {
          id: target.id,
          scoringTrace,
          sourceSpanId: snapshot?.trace.selectedSpanId ?? null,
          trace: snapshot
            ? { ...toTraceSummary(trace), ...frozenSummary, durationMs: durationMs(snapshot.trace.startedAt, snapshot.trace.endedAt) }
            : toTraceSummary(trace),
          datasetItemId: target.datasetItemId,
          datasetCaseId: snapshot?.datasetItem?.id ?? target.datasetItemId,
          stage: target.stage,
          executionError: target.executionError,
          expectedOutput: snapshot
            ? (snapshot.datasetItem?.expectedOutput ?? null)
            : item
              ? JSON.parse(item.expectedOutputJson ?? "null")
              : null,
          results: targetResults,
          scorerStatuses: progress.targets[target.id] ?? {},
        },
      ]
    })
    const execution = await executionState(this.database, this.projectId, id)
    const pinnedVersions = await this.database.select({ id: evalRunEvaluators.evaluatorId, version: evalRunEvaluators.evaluatorVersionId }).from(evalRunEvaluators).where(and(eq(evalRunEvaluators.projectId, this.projectId), eq(evalRunEvaluators.runId, id)))
    return {
      ...summary,
      evaluatorVersionIds: Object.fromEntries(pinnedVersions.map(v => [v.id,v.version])),
      execution: { ...execution, stalled: run.status === "running" && execution.stalled },
      scorerProgress: progress.scorers,
      results,
      rows,
      nextCursor: selectedTargetIds ? null : targetPage.nextCursor,
    }
  }

  private async createSavedViewUnsafe(
    input: CreateSavedViewInput
  ): Promise<SavedView> {
    const view: SavedView = {
      columns: input.columns,
      createdAt: now(),
      filters: input.filters ?? [],
      id: input.id ?? makeId("view"),
      name: input.name,
      resource: input.resource,
      sort: input.sort ?? null,
      updatedAt: now(),
    }
    assertViewConfiguration(view)
    await this.database.insert(savedViews).values({
      columnsJson: JSON.stringify(view.columns),
      createdAt: view.createdAt,
      filtersJson: JSON.stringify(view.filters),
      id: view.id,
      name: view.name,
      resource: view.resource,
      projectId: this.projectId,
      sortJson: view.sort === null ? null : JSON.stringify(view.sort),
      updatedAt: view.updatedAt,
    })
    return view
  }

  private async listSavedViewsUnsafe(options: ListOptions) {
    const page = await collectionSqlPage<SavedViewDbRow>(
      this.database,
      sql`select id,name,resource,columns_json as "columnsJson",filters_json as "filtersJson",sort_json as "sortJson",created_at as "createdAt",updated_at as "updatedAt" from saved_views where project_id=${this.projectId}`,
      options,
      "updatedAt"
    )
    return { ...page, items: page.items.map(toSavedView) }
  }

  private async getSavedViewUnsafe(id: string): Promise<SavedView> {
    const [row] = await this.database
      .select()
      .from(savedViews)
      .where(
        and(eq(savedViews.projectId, this.projectId), eq(savedViews.id, id))
      )
      .limit(1)
    if (!row) {
      throw notFound("Saved view", id)
    }
    return toSavedView(row)
  }

  private async patchSavedViewUnsafe(
    id: string,
    input: PatchSavedViewInput
  ): Promise<SavedView> {
    const current = await this.getSavedViewUnsafe(id)
    const updated: SavedView = {
      ...current,
      columns: input.columns ?? current.columns,
      filters: input.filters ?? current.filters,
      name: input.name ?? current.name,
      sort: input.sort === undefined ? current.sort : input.sort,
      updatedAt: now(),
    }
    assertViewConfiguration(updated)
    await this.database
      .update(savedViews)
      .set({
        columnsJson: JSON.stringify(updated.columns),
        filtersJson: JSON.stringify(updated.filters),
        name: updated.name,
        sortJson: updated.sort === null ? null : JSON.stringify(updated.sort),
        updatedAt: updated.updatedAt,
      })
      .where(
        and(eq(savedViews.projectId, this.projectId), eq(savedViews.id, id))
      )
    return updated
  }

  private async deleteSavedViewUnsafe(id: string) {
    const current = await this.getSavedViewUnsafe(id)
    await this.database
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.projectId, this.projectId),
          eq(savedViews.id, current.id)
        )
      )
    return { id }
  }

  private async getSavedViewDataUnsafe(
    id: string,
    query: SavedViewDataQuery
  ): Promise<SavedViewData> {
    const view = await this.getSavedViewUnsafe(id)
    if (query.runId && view.resource !== "eval-results") {
      throw validation("runId can only scope an eval-results saved view.")
    }
    if (query.runId) {
      await this.assertEvalRunExists(query.runId)
    }
    return savedViewSql(this.database, this.projectId, view, query)
  }

  private async createDemoUnsafe(): Promise<CreateDemoResponse> {
    // The demo exercises the SDK, but its transport is an in-process adapter
    // bound to this already-authorized service. It works on Vercel and cannot
    // lose the request's project scope through a loopback HTTP hop.
    const workflow = await runDemoWorkflow(
      createTracer({
        delivery: "direct",
        baseUrl: "http://datool-internal",
        fetch: this.createDemoFetch(),
      })
    )
    const suffix = workflow.traceIds[0]?.slice(-8) ?? makeId("demo").slice(-8)
    const dataset = await this.createDatasetUnsafe({
      description: workflow.dataset.description,
      name: `${workflow.dataset.name} ${suffix}`,
    })
    const itemIds: string[] = []
    for (const itemTemplate of workflow.dataset.items) {
      const sourceTraceId = workflow.traceIds[itemTemplate.sourceTraceIndex]
      if (!sourceTraceId) {
        throw new TracerError(
          "INTERNAL_ERROR",
          "The live demo workflow returned an item without a trace target."
        )
      }
      const item = await this.createDatasetItemUnsafe(dataset.id, {
        expectedOutput: itemTemplate.expectedOutput,
        input: itemTemplate.input,
        metadata: itemTemplate.metadata,
        sourceTraceId,
      })
      itemIds.push(item.id)
    }
    const evaluator = await this.createEvaluatorUnsafe({
      ...workflow.evaluator,
      id: undefined,
      name: `${workflow.evaluator.name} ${suffix}`,
    })
    const evalRun = await this.createEvalRunUnsafe({
      datasetId: dataset.id,
      datasetItemIds: itemIds,
      evaluatorIds: [evaluator.id],
      name: `Demo launch review ${suffix}`,
    })
    const view = await this.createSavedViewUnsafe({
      ...workflow.view,
      id: undefined,
      name: `${workflow.view.name} ${suffix}`,
    })
    return {
      datasetId: dataset.id,
      evaluatorId: evaluator.id,
      evalRunId: evalRun.id,
      sessionId: workflow.sessionId,
      traceIds: workflow.traceIds,
      viewId: view.id,
    }
  }

  private createDemoFetch(): typeof fetch {
    return async (input, init) => {
      try {
        const url = new URL(
          typeof input === "string" ? input : input.toString()
        )
        const method = init?.method ?? "GET"
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
        let data: unknown
        if (method === "POST" && url.pathname === "/api/sessions") {
          data = await this.createSessionUnsafe(body as CreateSessionInput)
        } else if (method === "POST" && url.pathname === "/api/traces") {
          data = await this.createTraceUnsafe(body as CreateTraceInput)
        } else if (
          method === "POST" &&
          /^\/api\/traces\/[^/]+\/spans$/.test(url.pathname)
        ) {
          const traceId = decodeURIComponent(url.pathname.split("/")[3]!)
          data = await this.createSpanUnsafe(traceId, body as CreateSpanInput)
        } else if (
          method === "PATCH" &&
          /^\/api\/traces\/[^/]+$/.test(url.pathname)
        ) {
          const traceId = decodeURIComponent(url.pathname.split("/")[3]!)
          data = await this.patchTraceUnsafe(traceId, body as PatchTraceInput)
        } else if (
          method === "PATCH" &&
          /^\/api\/spans\/[^/]+$/.test(url.pathname)
        ) {
          const spanId = decodeURIComponent(url.pathname.split("/")[3]!)
          data = await this.patchSpanUnsafe(spanId, body as PatchSpanInput)
        } else {
          return new Response(
            JSON.stringify({
              error: { message: "Unsupported internal demo SDK route." },
            }),
            { status: 404 }
          )
        }
        return new Response(JSON.stringify({ data }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      } catch (error) {
        const normalized =
          error instanceof TracerError
            ? error
            : new TracerError("INTERNAL_ERROR", "Demo SDK operation failed.")
        return new Response(
          JSON.stringify({ error: { message: normalized.message } }),
          {
            headers: { "content-type": "application/json" },
            status: normalized.status,
          }
        )
      }
    }
  }

  private async assertSessionExists(id: string) {
    const [session] = await this.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.projectId, this.projectId), eq(sessions.id, id)))
      .limit(1)
    if (!session) {
      throw notFound("Session", id)
    }
  }

  private async assertTraceExists(id: string) {
    const [trace] = await this.database
      .select({ id: traces.id })
      .from(traces)
      .where(and(eq(traces.projectId, this.projectId), eq(traces.id, id)))
      .limit(1)
    if (!trace) {
      throw notFound("Trace", id)
    }
  }

  private async assertDatasetExists(id: string) {
    const [dataset] = await this.database
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.projectId, this.projectId), eq(datasets.id, id)))
      .limit(1)
    if (!dataset) {
      throw notFound("Dataset", id)
    }
  }

  private async assertEvalRunExists(id: string) {
    const [run] = await this.database
      .select({ id: evalRuns.id })
      .from(evalRuns)
      .where(and(eq(evalRuns.projectId, this.projectId), eq(evalRuns.id, id)))
      .limit(1)
    if (!run) {
      throw notFound("Eval run", id)
    }
  }

  private async spanParentRows(traceId: string) {
    return this.database
      .select({ id: spans.id, parentId: spans.parentId })
      .from(spans)
      .where(
        and(eq(spans.projectId, this.projectId), eq(spans.traceId, traceId))
      )
  }

  /**
   * Trace graphs are trees/forests in v1. Validate the full parent map before
   * any insert or reparent write so the UI never receives a cycle with no root.
   */
  private assertSpanParentGraph(
    rows: Array<{ id: string; parentId: string | null }>,
    requireKnownParent: boolean
  ) {
    const parentById = new Map<string, string | null>()
    for (const row of rows) {
      if (parentById.has(row.id)) {
        throw validation("Span IDs must be unique within a trace.", {
          spanId: row.id,
        })
      }
      parentById.set(row.id, row.parentId)
    }
    for (const row of rows) {
      let currentId = row.id
      const ancestry = new Set<string>()
      while (true) {
        if (ancestry.has(currentId)) {
          throw validation("Span parents must not form a cycle.", {
            spanId: row.id,
          })
        }
        ancestry.add(currentId)
        const parentId = parentById.get(currentId)
        if (parentId === null || parentId === undefined) {
          break
        }
        if (!parentById.has(parentId)) {
          if (requireKnownParent) {
            throw validation("A span parent must belong to the same trace.", {
              parentId,
              spanId: row.id,
            })
          }
          break
        }
        currentId = parentId
      }
    }
  }

  private async toEvaluator(row: EvaluatorRow): Promise<Evaluator> {
    if (!row.activeVersionId) {
      throw new TracerError(
        "INTERNAL_ERROR",
        `Evaluator '${row.id}' has no active version.`
      )
    }
    const [version] = await this.database
      .select()
      .from(evaluatorVersions)
      .where(
        and(
          eq(evaluatorVersions.projectId, this.projectId),
          eq(evaluatorVersions.id, row.activeVersionId)
        )
      )
      .limit(1)
    if (!version) {
      throw new TracerError(
        "INTERNAL_ERROR",
        `Evaluator '${row.id}' points to a missing active version.`
      )
    }
    return {
      activeVersion: toEvaluatorVersion(version),
      createdAt: row.createdAt,
      description: row.description,
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
    }
  }

  private async resolveEvalTargets(
    datasetId: string | undefined,
    requestedDatasetItemIds: string[] | undefined,
    requestedTraceIds: string[]
  ): Promise<EvalTarget[]> {
    const targets: EvalTarget[] = []
    for (const traceId of requestedTraceIds) {
      targets.push({
        datasetItem: null,
        trace: await this.getTraceUnsafe(traceId),
      })
    }
    if (!datasetId) {
      return targets
    }
    await this.assertDatasetExists(datasetId)
    const rows = requestedDatasetItemIds?.length
      ? await this.database
          .select()
          .from(datasetItems)
          .where(
            and(
              eq(datasetItems.projectId, this.projectId),
              eq(datasetItems.datasetId, datasetId),
              inArray(datasetItems.id, requestedDatasetItemIds)
            )
          )
      : await this.database
          .select()
          .from(datasetItems)
          .where(
            and(
              eq(datasetItems.projectId, this.projectId),
              eq(datasetItems.datasetId, datasetId)
            )
          )
    if (
      requestedDatasetItemIds?.length &&
      rows.length !== requestedDatasetItemIds.length
    ) {
      throw validation(
        "One or more selected dataset items do not belong to this dataset."
      )
    }
    if (!rows.length) {
      throw validation("The selected dataset has no items to evaluate.")
    }
    for (const row of rows) {
      const item = toDatasetItem(row)
      if (!item.sourceTraceId) {
        throw validation(
          "Every evaluated dataset item must reference sourceTraceId in v1.",
          {
            datasetItemId: item.id,
          }
        )
      }
      targets.push({
        datasetItem: item,
        trace: await this.datasetEvidence(item),
      })
    }
    return targets
  }

  private async persistEvaluatorResult(
    runId: string,
    target: EvalTarget,
    evaluator: Evaluator,
    rawResult: EvaluatorRunResult,
    owner?: string
  ) {
    const result = normalizeEvaluatorResult(rawResult)
    const timestamp = now()
    const resultId = makeId("eres")
    const resultStatus = evalResultStatusFor(result)
    await this.database.transaction(async (transaction) => {
      if (owner) {
        const current = await transaction.execute(sql`select r.id from eval_runs r join eval_run_lease l on l.run_id=r.id where r.project_id=${this.projectId} and r.id=${runId} and r.status='running' and l.owner=${owner} and l.expires_at>now() for update of r`)
        if (!current.rows.length) throw new TracerError("CONFLICT", "Run cancelled or execution ownership changed")
      }
      await transaction.execute(sql`delete from eval_results where project_id=${this.projectId} and run_id=${runId} and evaluator_id=${evaluator.id} and (target_id=${target.targetId!} or (target_id is null and metadata_json::jsonb->>'evalTargetId'=${target.targetId!})) and status='error'`)
      await transaction.insert(evalResults).values({
        targetId: target.targetId!,
        completedAt: timestamp,
        createdAt: timestamp,
        datasetItemId:
          target.datasetItemReference === undefined
            ? (target.datasetItem?.id ?? null)
            : target.datasetItemReference,
        error: result.error?.message ?? null,
        evaluatorId: evaluator.id,
        evaluatorVersionId: evaluator.activeVersion.id,
        id: resultId,
        projectId: this.projectId,
        metadataJson: JSON.stringify({
          ...result.metadata,
          scorerName: evaluator.name,
          evalTargetId: target.targetId!,
        }),
        passed: result.passed,
        reasoning: result.reasoning ?? null,
        runId,
        score: result.score,
        status: resultStatus,
        traceId: target.trace.id,
      })
      await transaction.insert(scores).values({
        createdAt: timestamp,
        evalResultId: resultId,
        evaluatorId: evaluator.id,
        id: makeId("score"),
        projectId: this.projectId,
        name: "score",
        status: scoreStatusFor(result),
        traceId: target.trace.id,
        value: result.score,
      })
    })
  }

  private async getEvalResultsForRun(
    runId: string | undefined,
    resultIds?: string[],
    targetIds?: string[]
  ): Promise<EvalResult[]> {
    const rows = await this.database
      .select()
      .from(evalResults)
      .where(
        and(
          eq(evalResults.projectId, this.projectId),
          runId ? eq(evalResults.runId, runId) : undefined,
          resultIds ? inArray(evalResults.id, resultIds) : undefined,
          targetIds
            ? sql`exists(select 1 from eval_run_targets t where t.project_id=${this.projectId} and t.run_id=${runId} and t.id in (${sql.join(
                targetIds.map((id) => sql`${id}`),
                sql`, `
              )}) and (${evalResults.targetId}=t.id or (${evalResults.targetId} is null and ((${evalResults.metadataJson}::jsonb ->> 'evalTargetId')=t.id or (not (${evalResults.metadataJson}::jsonb ? 'evalTargetId') and t.trace_id=${evalResults.traceId} and t.dataset_item_id is not distinct from ${evalResults.datasetItemId})))))`
            : undefined
        )
      )
      .orderBy(evalResults.createdAt, evalResults.id)
    const evaluatorIds = [...new Set(rows.map((row) => row.evaluatorId))]
    const evaluatorVersionIds = [
      ...new Set(rows.map((row) => row.evaluatorVersionId)),
    ]
    const [evaluatorRows, versionRows] = await Promise.all([
      evaluatorIds.length
        ? this.database
            .select()
            .from(evaluators)
            .where(
              and(
                eq(evaluators.projectId, this.projectId),
                inArray(evaluators.id, evaluatorIds)
              )
            )
        : [],
      evaluatorVersionIds.length
        ? this.database
            .select()
            .from(evaluatorVersions)
            .where(
              and(
                eq(evaluatorVersions.projectId, this.projectId),
                inArray(evaluatorVersions.id, evaluatorVersionIds)
              )
            )
        : [],
    ])
    const evaluatorNames = new Map(
      evaluatorRows.map((evaluator) => [evaluator.id, evaluator.name])
    )
    const evaluatorVersionsById = new Map(
      versionRows.map((version) => [version.id, version.version])
    )
    const definitionsById = new Map(
      versionRows.map((version) => [version.id, toEvaluatorVersion(version)])
    )
    return rows.map((row) => {
      const status = row.status
      if (
        status !== "completed" &&
        status !== "error" &&
        status !== "failed" &&
        status !== "passed"
      ) {
        throw new TracerError(
          "INTERNAL_ERROR",
          `Unknown eval result status '${status}'.`
        )
      }
      return {
        completedAt: row.completedAt,
        datasetItemId: row.datasetItemId,
        error: row.error,
        evaluatorId: row.evaluatorId,
        evaluatorName: String(
          fromObjectJson(row.metadataJson).scorerName ??
            evaluatorNames.get(row.evaluatorId) ??
            "Unknown evaluator"
        ),
        evaluatorVersion:
          evaluatorVersionsById.get(row.evaluatorVersionId) ?? 0,
        definition: definitionsById.get(row.evaluatorVersionId),
        id: row.id,
        metadata: fromObjectJson(row.metadataJson),
        passed: row.passed,
        reasoning: row.reasoning,
        runId: row.runId,
        score: row.score,
        status,
        traceId: row.traceId,
      }
    })
  }
}

type TracerGlobal = typeof globalThis & {
  __datoolTracerServicePromises?: Map<string, Promise<TracerService>>
}

async function createInitializedTracerService(projectId: string) {
  const database = createTracerDatabase(undefined, { projectId })
  await recoverInterruptedEvalRuns(database, { staleOnly: true })
  return new TracerService(database, { promptCache: runtimePromptCache() })
}

/** A cached service is keyed by project ID; it never carries another tenant's data. */
export function getTracerService(projectId: string) {
  const globalForTracer = globalThis as TracerGlobal
  globalForTracer.__datoolTracerServicePromises ??= new Map()
  const services = globalForTracer.__datoolTracerServicePromises
  let service = services.get(projectId)
  if (!service) {
    service = createInitializedTracerService(projectId)
    services.set(projectId, service)
  }
  return service.then(TracerService.withCurrentCode)
}

export async function createTestTracerService(
  databaseUrl: string,
  projectId: string
) {
  return new TracerService(createTracerDatabase(databaseUrl, { projectId }))
}

/** Expired workers are visible as interrupted; recovery is an explicit, fenced operation. */
export async function recoverInterruptedEvalRuns(database: TracerDatabase, options?: { staleOnly: boolean }) {
  await database.execute(sql`update eval_runs set status=case when exists(select 1 from eval_run_targets t where t.run_id=eval_runs.id) and not exists(select 1 from eval_run_targets t where t.run_id=eval_runs.id and t.stage<>'completed') then 'completed' when exists(select 1 from eval_run_targets t where t.run_id=eval_runs.id and t.stage='completed') then 'partial' else 'failed' end,completed_at=${now()},metadata_json=(metadata_json::jsonb || '{"interruption":"Worker lease expired. Completed results are preserved; recover unfinished work after inspecting case stages."}'::jsonb)::text
    where project_id=${getTracerProjectId(database)} and status='running' ${options?.staleOnly ? sql`and created_at::timestamptz<now()-interval '45 seconds'` : sql``}
    and not exists(select 1 from eval_run_lease where run_id=eval_runs.id and expires_at>now())`)
}

function readGroup(value: unknown) {
  if (value === undefined) return undefined
  const parsed = invocationGroupSchema.safeParse(value)
  if (!parsed.success) throw validation("Invalid invocation group.")
  return parsed.data
}

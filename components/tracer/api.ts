"use client"

import type { PromoteSpansInput, SpanPromotionResult } from "@/src/lib/tracer/span-promotion"

import type { HumanScore, HumanScoreInput, HumanScoreLibrary, HumanScoreCollectionInput, HumanScoreCollectionSnapshot } from "@/src/lib/tracer/human-scores"

import type { CreateReviewSession, ReviewSelection, ReviewSessionTable, UpdateReviewSession, RecordReview, ReviewOptions, ReviewSession, ReviewSessionDetail, ReviewItemDetail } from "@/src/lib/tracer/reviews"
import { createConditionalReadCache } from "@/src/lib/tracer/conditional-read"
import { currentProjectScope, projectFetch } from "@/lib/workspace-routing"
import type { CreateLibraryEntry, CreatedLibraryEntry, DatasetLibraryEntry, MoveLibraryEntry } from "@/src/lib/tracer/dataset-library"

import type { CustomView, CustomViewInput } from "@/src/lib/tracer/custom-views"
import { createPageViewCache } from "@/src/lib/tracer/page-view-cache"

import type { SemanticQueryInput, SemanticResult } from "@/src/lib/semantic"

import type {
  ApiEnvelope,
  ApiError,
  ApiList,
  CreateDatasetInput,
  CreateDatasetItemInput,
  CreateDemoResponse,
  CreateEvaluatorInput,
  CreateEvalRunInput,
  CreateSavedViewInput,
  CreateSessionInput,
  CreateSpanInput,
  CreateTraceInput,
  Dataset,
  DatasetDetail,
  DatasetItem,
  DatasetItemPreview,
  DatasetVersion,
  EvalRun,
  EvalRunSummary,
  EvalRunGroupSummary,
  EvalRunComparison,
  EvalRunDetail,
  Evaluator,
  PatchEvaluatorInput,
  PatchDatasetInput,
  PatchDatasetItemInput,
  SavedView,
  SavedViewData,
  Session,
  SessionDetail,
  Span,
  TraceDetail,
  TraceOverview,
  TraceSummary,
} from "@/src/lib/tracer/contracts"

export class TracerApiError extends Error {
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, options?: { code?: string; details?: unknown }) {
    super(message)
    this.name = "TracerApiError"
    this.code = options?.code
    this.details = options?.details
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown
  projectId?: string
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? ""

  if (!contentType.includes("application/json")) {
    return response.text()
  }

  return response.json()
}

const conditionalReads = createConditionalReadCache()
let forceReadsUntil = 0

async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { projectId, ...requestOptions } = options
  const scope = currentProjectScope()
  const boundProjectId = projectId ?? scope?.projectId
  const isGet = !options.method || options.method === "GET"
  const conditional = isGet && !!boundProjectId && (
    /^\/api\/traces(?:\?|$|\/[^/]+\/overview(?:\?|$))/.test(path) ||
    /^\/api\/(?:sessions|evals)(?:\?|$|\/[^/?]+(?:\?|$))/.test(path)
  )
  const force = Date.now() < forceReadsUntil || new URL(path, "http://local").searchParams.get("includeTotal") === "true"
  const load = (etag?: string) => projectFetch(path, {
    ...requestOptions,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    credentials: "include",
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...options.headers,
      ...(etag ? { "if-none-match": etag } : {}),
      ...(isGet && force ? { "x-datool-refresh": "force" } : {}),
    },
  }, boundProjectId)
  const response = conditional
    ? await conditionalReads.fetch(`${scope?.organizationId}:${boundProjectId}:${path}`, load, force)
    : await load()
  if (response.ok && !isGet && !path.startsWith("/api/metrics/")) {
    conditionalReads.clear()
    forceReadsUntil = Date.now() + 3_000
  }
  const payload = await readPayload(response)

  if (
    !response.ok ||
    (typeof payload === "object" && payload !== null && "error" in payload)
  ) {
    const error = payload as ApiError
    const message =
      error.error?.message || `Request failed (${response.status})`

    throw new TracerApiError(message, {
      code: error.error?.code,
      details: error.error?.details,
    })
  }

  return (payload as ApiEnvelope<T>).data
}

function collection<T>(path: string, signal?: AbortSignal) {
  return request<ApiList<T>>(path, { signal })
}

function withQuery(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.set(key, value)
    }
  }

  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}

export type CollectionListOptions = {
  includeTotal?: boolean
  signal?: AbortSignal
  filter?: string
  cursor?: string
  limit?: number
}

export type TraceListOptions = CollectionListOptions & { sessionId?: string; datasetItemId?: string }

export const tracerApi = {
  operation: <T,>(operation: string, input: unknown, signal?: AbortSignal) => request<T>(`/api/agent/${operation}`, { method: "POST", body: input, signal }),
  humanScores: {
    library: (signal?: AbortSignal) => request<HumanScoreLibrary>("/api/human-scores", {signal}),
    create: (input:HumanScoreInput) => request<HumanScore>("/api/human-scores", {method:"POST",body:input}),
    update: (id:string, expectedRevision:number, score:HumanScoreInput) => request<HumanScore>(`/api/human-scores/${encodeURIComponent(id)}`, {method:"PATCH",body:{expectedRevision,score}}),
    createCollection: (input:HumanScoreCollectionInput) => request<HumanScoreCollectionSnapshot>("/api/human-score-collections", {method:"POST",body:input}),
    updateCollection: (id:string,expectedRevision:number,collection:HumanScoreCollectionInput) => request<HumanScoreCollectionSnapshot>(`/api/human-score-collections/${encodeURIComponent(id)}`, {method:"PATCH",body:{expectedRevision,collection}}),
  },
  reviews: {
    table: (id: string, signal?: AbortSignal) => request<ReviewSessionTable>(`/api/reviews/${encodeURIComponent(id)}/table`, { signal }),
    mutateSelection: (id: string, input: ReviewSelection) => request<ReviewSessionDetail>(`/api/reviews/${encodeURIComponent(id)}/items`, { method: "PATCH", body: input }),
    list: (options: CollectionListOptions = {}) => collection<ReviewSession>(withQuery("/api/reviews", {
      filter: options.filter, cursor: options.cursor, limit: options.limit?.toString(), includeTotal: options.includeTotal?.toString(),
    }), options.signal),
    get: (id: string, signal?: AbortSignal) => request<ReviewSessionDetail>(`/api/reviews/${encodeURIComponent(id)}`, { signal }),
    options: (signal?: AbortSignal) => request<ReviewOptions>("/api/reviews/options", { signal }),
    create: (input: CreateReviewSession) => request<ReviewSessionDetail>("/api/reviews", { method: "POST", body: input }),
    update: (id: string, input: UpdateReviewSession) => request<ReviewSessionDetail>(`/api/reviews/${encodeURIComponent(id)}`, { method: "PATCH", body: input }),
    item: (sessionId: string, itemId: string, signal?: AbortSignal) => request<ReviewItemDetail>(`/api/reviews/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}`, { signal }),
    record: (sessionId: string, itemId: string, input: RecordReview) => request<ReviewItemDetail>(`/api/reviews/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}`, { method: "PUT", body: input }),
  },
  performance: (query: SemanticQueryInput, signal?: AbortSignal) =>
    request<SemanticResult>("/api/metrics/query", {
      method: "POST",
      body: query,
      signal,
    }),
  demo: () => request<CreateDemoResponse>("/api/demo", { method: "POST" }),
  traces: {
    mutateSelection: (input: import("@/src/lib/tracer/trace-selection").TraceSelectionMutation) =>
      request<{ traceIds: string[] }>("/api/traces/selection", { method: "POST", body: input }),
    overview: (id: string, signal?: AbortSignal, includeRootDetail = false) =>
      request<TraceOverview>(`/api/traces/${encodeURIComponent(id)}/overview${includeRootDetail ? "?includeRootDetail=true" : ""}`, { signal }),
    payload: (id: string, signal?: AbortSignal) =>
      request<TraceSummary>(`/api/traces/${encodeURIComponent(id)}/payload`, { signal }),
    span: (traceId: string, spanId: string, signal?: AbortSignal) =>
      request<Span>(`/api/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}/detail`, { signal }),
    spanPath: (traceId: string, spanId: string, signal?: AbortSignal) =>
      request<Span[]>(
        `/api/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`,
        { signal }
      ),
    scores: (id: string, options: CollectionListOptions = {}) =>
      collection<
        import("@/src/lib/tracer/contracts").TraceScore & { id: string }
      >(
        withQuery(`/api/traces/${encodeURIComponent(id)}/scores`, {
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
    spans: (id: string, options: CollectionListOptions = {}) =>
      collection<Span>(
        withQuery(`/api/traces/${encodeURIComponent(id)}/spans`, {
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
    create: (input: CreateTraceInput) =>
      request<TraceDetail>("/api/traces", { body: input, method: "POST" }),
    createSpan: (traceId: string, input: CreateSpanInput) =>
      request<Span>(`/api/traces/${encodeURIComponent(traceId)}/spans`, {
        body: input,
        method: "POST",
      }),
    get: (id: string, signal?: AbortSignal) =>
      request<TraceDetail>(`/api/traces/${encodeURIComponent(id)}`, { signal }),
    list: (options: TraceListOptions = {}) =>
      collection<TraceSummary>(
        withQuery("/api/traces", {
          filter: options.filter,
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
          sessionId: options.sessionId,
          datasetItemId: options.datasetItemId,
        }),
        options.signal
      ),
  },
  sessions: {
    create: (input: CreateSessionInput) =>
      request<Session>("/api/sessions", { body: input, method: "POST" }),
    get: (id: string, signal?: AbortSignal) =>
      request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`, { signal }),
    list: (options: CollectionListOptions = {}) =>
      collection<Session>(
        withQuery("/api/sessions", {
          filter: options.filter,
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
  },
  datasets: {
    promoteSpans: (input: PromoteSpansInput) => request<SpanPromotionResult>("/api/agent/promote_spans", { method: "POST", body: input }),
    versions: (id: string, options: CollectionListOptions = {}) =>
      collection<DatasetVersion>(withQuery(`/api/datasets/${encodeURIComponent(id)}/versions`, {
        cursor: options.cursor,
        limit: options.limit?.toString(),
        includeTotal: options.includeTotal?.toString(),
      }), options.signal),
    update: (id: string, input: PatchDatasetInput) =>
      request<Dataset>(`/api/datasets/${encodeURIComponent(id)}`, { body: input, method: "PATCH" }),
    updateItem: (id: string, input: PatchDatasetItemInput) =>
      request<DatasetItem>(`/api/dataset-items/${encodeURIComponent(id)}`, { body: input, method: "PATCH" }),
    deleteItem: (id: string) =>
      request<{ id: string }>(`/api/dataset-items/${encodeURIComponent(id)}`, { method: "DELETE" }),
    importItems: (datasetId: string, items: CreateDatasetItemInput[]) =>
      request<unknown>("/api/agent/bulk_dataset_items", { method: "POST", body: { datasetId, create: items } }),
    library: (options: CollectionListOptions & { folderId?: string | null; scope?: "tree"; projectId?: string } = {}) =>
      request<ApiList<DatasetLibraryEntry>>(withQuery("/api/datasets/library", {
        scope: options.scope,
        folderId: options.folderId ?? undefined,
        filter: options.filter,
        cursor: options.cursor,
        limit: options.limit?.toString(),
      }), { signal: options.signal, projectId: options.projectId }),
    addEntry: (input: CreateLibraryEntry, projectId?: string) =>
      request<CreatedLibraryEntry>("/api/datasets/library", { body: input, method: "POST", projectId }),
    moveEntry: (input: MoveLibraryEntry, projectId?: string) =>
      request<{ id: string; name: string }>("/api/datasets/library", { body: input, method: "PATCH", projectId }),
    getItem: (id: string, signal?: AbortSignal) =>
      request<DatasetItem>(`/api/dataset-items/${encodeURIComponent(id)}`, { signal }),
    items: (id: string, options: CollectionListOptions & { preview?: boolean } = {}) =>
      collection<DatasetItemPreview>(
        withQuery(`/api/datasets/${encodeURIComponent(id)}/items`, {
          filter: options.filter,
          preview: options.preview?.toString(),
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
    create: (input: CreateDatasetInput) =>
      request<Dataset>("/api/datasets", { body: input, method: "POST" }),
    createItem: (datasetId: string, input: CreateDatasetItemInput) =>
      request<DatasetItem>(
        `/api/datasets/${encodeURIComponent(datasetId)}/items`,
        {
          body: input,
          method: "POST",
        }
      ),
    get: (id: string, options: { includeItems?: boolean } = {}) =>
      request<DatasetDetail>(withQuery(`/api/datasets/${encodeURIComponent(id)}`, { includeItems: options.includeItems?.toString() })),
    list: (options: CollectionListOptions = {}) =>
      collection<Dataset>(
        withQuery("/api/datasets", {
          filter: options.filter,
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
  },
  evaluators: {
    useLibrary: (evaluator: import("@/src/lib/tracer/scorer-libraries").LibraryEvaluatorId) =>
      request<Evaluator>("/api/scorers/libraries", { method: "POST", body: { evaluator } }),
    create: (input: CreateEvaluatorInput) =>
      request<Evaluator>("/api/evaluators", { body: input, method: "POST" }),
    list: (options: CollectionListOptions = {}) => collection<Evaluator>(withQuery("/api/evaluators", {
      cursor: options.cursor, limit: options.limit?.toString(),
    }), options.signal),
    update: (id: string, input: PatchEvaluatorInput) =>
      request<Evaluator>(`/api/evaluators/${encodeURIComponent(id)}`, {
        body: input,
        method: "PATCH",
      }),
  },
  evals: {
    groups: (groupBy: "workflow" | "agent", options: CollectionListOptions = {}) =>
      collection<EvalRunGroupSummary>(withQuery("/api/evals/groups", {
        groupBy, filter: options.filter, cursor: options.cursor,
        limit: options.limit?.toString(), includeTotal: options.includeTotal?.toString(),
      }), options.signal),
    compare: (leftId: string, rightId: string, offset = 0, signal?: AbortSignal) =>
      request<EvalRunComparison>(
        withQuery("/api/evals/compare", {
          leftId,
          rightId,
          includeEvidence: "false",
          offset: String(offset),
        }),
        { signal }
      ),
    target: (runId: string, targetId: string, signal?: AbortSignal) =>
      request<NonNullable<EvalRunDetail["rows"]>[number]>(
        `/api/evals/${encodeURIComponent(runId)}/targets/${encodeURIComponent(targetId)}`,
        { signal }
      ),
    create: (input: CreateEvalRunInput) =>
      request<EvalRun>("/api/evals", { body: input, method: "POST" }),
    get: (id: string, options: CollectionListOptions = {}) =>
      request<EvalRunDetail>(
        withQuery(`/api/evals/${encodeURIComponent(id)}`, {
          includeEvidence: "false",
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        { signal: options.signal }
      ),
    list: (options: CollectionListOptions = {}) =>
      collection<EvalRunSummary>(
        withQuery("/api/evals", {
          filter: options.filter,
          cursor: options.cursor,
          includeTotal: options.includeTotal?.toString(),
          limit: options.limit?.toString(),
        }),
        options.signal
      ),
  },
  views: {
    create: (input: CreateSavedViewInput) =>
      request<SavedView>("/api/views", { body: input, method: "POST" }),
    data: (id: string, runId?: string, offset = 0) =>
      request<SavedViewData>(
        withQuery(`/api/views/${encodeURIComponent(id)}/data`, {
          runId,
          offset: String(offset),
          limit: "50",
        })
      ),
    list: async (resource?: "eval-results" | "traces") => {
      const result = await collection<SavedView>("/api/views")
      return resource
        ? {
            ...result,
            items: result.items.filter((view) => view.resource === resource),
          }
        : result
    },
  },
}

const pageViewCache = createPageViewCache()
export const customViewsApi = {
  list: async (resource: CustomViewInput["resource"] = "eval-runs") => {
    const projectId = currentProjectScope()?.projectId ?? ""
    return pageViewCache.list(projectId, resource, async () => {
    const views: CustomView[] = []
    let cursor: string | null = null
    do {
      const page: { items: CustomView[]; nextCursor: string | null } = await request(`/api/page-views?resource=${resource}&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, { projectId })
      views.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return views
    })
  },
  get: (id: string, fresh = false) => {
    const projectId = currentProjectScope()?.projectId ?? ""
    return pageViewCache.get(projectId, id, () => request<CustomView>(`/api/page-views/${encodeURIComponent(id)}`, { projectId }), fresh)
  },
  create: async (input: CustomViewInput) => {
    const projectId = currentProjectScope()?.projectId ?? ""
    return pageViewCache.remember(projectId, await request<CustomView>("/api/page-views", { projectId, method: "POST", body: input }))
  },
  update: async (id: string, input: CustomViewInput & { expectedRevision: number }) => {
    const projectId = currentProjectScope()?.projectId ?? ""
    return pageViewCache.remember(projectId, await request<CustomView>(`/api/page-views/${encodeURIComponent(id)}`, {
      projectId,
      method: "PUT",
      body: input,
    }))
  },
  delete: async (id: string, revision: number) => {
    const projectId = currentProjectScope()?.projectId ?? ""
    const deleted = await request<{ id: string }>(
      `/api/page-views/${encodeURIComponent(id)}?expectedRevision=${revision}`,
      { projectId, method: "DELETE" }
    )
    pageViewCache.remove(projectId, id)
    return deleted
  },
  history: (id: string) => request<{ items: { definition: CustomView; revision: number }[] }>(`/api/page-views/${encodeURIComponent(id)}/history`),
  restore: async (id: string, revision: number, expectedRevision: number) => {
    const projectId = currentProjectScope()?.projectId ?? ""
    return pageViewCache.remember(projectId, await request<CustomView>(`/api/page-views/${encodeURIComponent(id)}/restore`, { projectId, method: "POST", body: { revision, expectedRevision } }))
  },
}

export const reactViewsApi = {
  list: (projectId: string, cursor?: string, signal?: AbortSignal) => request<import("@/src/lib/tracer/react-views").ReactViewPage>(withQuery("/api/object-views", { cursor }), { projectId, signal }),
  get: (projectId: string, id: string) => request<import("@/src/lib/tracer/react-views").ReactView>(`/api/object-views/${encodeURIComponent(id)}`, { projectId }),
  create: (projectId: string, input: import("@/src/lib/tracer/react-views").ReactViewInput & { source: import("@/src/lib/tracer/react-views").ReactViewSource | null }) => request<import("@/src/lib/tracer/react-views").ReactView>("/api/object-views", { projectId, method: "POST", body: input }),
  update: (projectId: string, id: string, input: import("@/src/lib/tracer/react-views").ReactViewInput & { expectedRevision: number }) => request<import("@/src/lib/tracer/react-views").ReactView>(`/api/object-views/${encodeURIComponent(id)}`, { projectId, method: "PUT", body: input }),
  delete: (projectId: string, id: string, revision: number) => request<{ id: string }>(`/api/object-views/${encodeURIComponent(id)}?expectedRevision=${revision}`, { projectId, method: "DELETE" }),
  suggest: (projectId: string, code: string, sample: TraceDetail) => request<{ requirements: import("@/src/lib/tracer/react-views").ViewRequirement[]; notice: string }>("/api/react-views/suggest", { projectId, method: "POST", body: { code, sample } }),
}

import { reportComponentsCatalog, dashboardReportDocument } from "@/src/lib/tracer/report-mdx"
import { reportValidationSchema, reportInputSchema, reportUpdateSchema, reportPublishSchema, reportShareSchema, reportCloneSchema } from "@/src/lib/tracer/reports"
import { evaluationStoryRecipe } from "@/src/lib/tracer/report-recipe"
import { reportAuthoringGuide } from "@/src/lib/tracer/report-authoring-guide"
import { reportTemplates } from "@/src/lib/tracer/report-templates"
import { promoteSpansSchema } from "@/src/lib/tracer/span-promotion"
import { viewOperations } from "@/src/lib/tracer/view-operations"
import { executeViewOperation } from "../tracer/view-operations"
import {
  humanScoreInputSchema,
  humanScoreUpdateSchema,
  humanScoreCollectionInputSchema,
  humanScoreCollectionUpdateSchema,
} from "@/src/lib/tracer/human-scores"
import type { WorkspaceScope } from "@/src/lib/auth/permissions"
import { z } from "zod"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  dashboardInputSchema,
  dashboardUpdateSchema,
} from "@/src/lib/tracer/dashboards"
import {
  reviewSessionInputSchema,
  reviewSessionUpdateSchema,
  recordReviewSchema,
} from "@/src/lib/tracer/reviews"
import { scorerInputSchema } from "@/src/lib/tracer/scorers"
import {
  scorerLibraries,
  defaultLibraryMappings,
  libraryEvaluatorIds,
} from "@/src/lib/tracer/scorer-libraries"
import {
  customViewInputSchema,
  customViewUpdateSchema,
} from "@/src/lib/tracer/custom-views"
import type { TracerService } from "../tracer/service"
import { tracerEffect, type TracerEffect } from "../tracer/effect"
import { validation as invalid } from "../tracer/errors"
import * as validation from "../tracer/validation"
import { appRegistrationSchema, listApps, registerApps } from "../apps/catalog"
import { resolveApp, validateAppInput } from "../apps/invoke"
import { prepareAppScoring } from "../apps/scoring"
import { runTracerEffect } from "../tracer/effect"
import type { JsonValue } from "@/src/lib/tracer/contracts"

const id = z.string().min(1).max(128)
const paging = z.object({
  includeTotal: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
  filter: z.string().max(4000).optional(),
})
export type AgentOperation = {
  name: string
  description: string
  scopes: readonly WorkspaceScope[]
  schema: z.ZodObject<z.ZodRawShape>
  destructive: boolean
  execute: (service: TracerService, input: unknown) => TracerEffect<unknown>
}
const operations: AgentOperation[] = []
for (const operation of viewOperations) operations.push({
  name: operation.name, description: operation.description,
  scopes: [operation.write ? "views:write" : "views:read"],
  schema: operation.schema, destructive: operation.action === "delete",
  execute: (service, input) => executeViewOperation(operation, service, input),
})
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  scopes: WorkspaceScope | WorkspaceScope[],
  schema: z.ZodObject<S>,
  action: (
    service: TracerService,
    input: z.infer<z.ZodObject<S>>
  ) => TracerEffect<unknown>,
  destructive = false
) {
  operations.push({
    name,
    description,
    scopes: typeof scopes === "string" ? [scopes] : scopes,
    schema,
    destructive,
    execute: (service, input) => {
      const parsed = schema.strict().safeParse(input)
      if (!parsed.success)
        return tracerEffect(async () => {
          throw invalid(
            parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")
          )
        })
      return action(service, parsed.data)
    },
  })
}
tool(
  "list_apps",
  "List registered apps, connection types, input/output schemas and availability. HTTP apps are always available; availability is not a health check.",
  "apps:read",
  z.object({}),
  () => tracerEffect(listApps)
)
tool(
  "get_app",
  "Read one app and its connection configuration. Credential values are never returned.",
  "apps:read",
  z.object({ id }),
  (_s, p) =>
    tracerEffect(async () => {
      const app = (await listApps()).find((app) => app.id === p.id)
      if (!app) throw invalid("App not found.")
      return app
    })
)
tool(
  "register_app",
  "Register an app with a local bridge or HTTP webhook connection. Use expectedRevision when editing. Omitted webhook headers preserve saved credentials; {} clears them. Registration does not call the app.",
  "apps:write",
  z.object({ app: appRegistrationSchema }),
  (_s, p) => tracerEffect(async () => (await registerApps([p.app]))[0])
)
tool(
  "run_app",
  "Run one input through a registered app and save its experiment and traces. Reuse requestKey after uncertain delivery to prevent duplicate execution; inspect eval runs if the request is still starting. scorerIds omitted uses app defaults; [] runs without scorers. Calls may incur cost.",
  ["apps:read", "apps:write", "evals:read", "evals:write", "scorers:read"],
  z.object({
    id,
    input: z.json(),
    requestKey: id,
    scorerIds: z.array(id).max(10).optional(),
  }),
  (service, p) =>
    tracerEffect(async () => {
      const app = await resolveApp(p.id)
      validateAppInput(app, p.input)
      const versions = await prepareAppScoring(
        service,
        p.scorerIds ?? app.definition.evaluatorIds
      )
      return runTracerEffect(
        service.agent.startEval(
          {
            requestKey: p.requestKey,
            mode: "connected",
            appId: p.id,
            input: p.input as JsonValue,
            evaluatorIds: Object.keys(versions),
            evaluatorVersionIds: versions,
            name: `Playground · ${app.definition.name}`,
            metadata: { source: "playground", appId: p.id },
          },
          { background: false }
        )
      )
    })
)
tool(
  "get_metrics_metadata",
  "Discover semantic sources, measures, dimensions, time dimensions, segments, and query limits before constructing metric queries. Prefer source.visibility=primary for new queries: Traces (traces), Spans (spans), Evaluation Runs (evalRuns), Evaluation Results (evalResults), Scores (scoreValues). Inspect member definitions, denominators, grouping/filter capabilities and source.unavailable; legacy scores is not the Scores ratings source.",
  "metrics:read",
  z.object({}),
  (service) => service.getSemanticMetricsMetadata()
)
tool(
  "query_metrics",
  "Run a bounded read-only semantic query using discovered catalog members and the source's time dimension. Score measures marked requiresDefinition need one compatible scoreValues.definitionId or grouping by it. Returns data, annotations, quality, and execution metadata; does not accept SQL or executable definitions. On READ_BUSY, honor details.retryAfterSeconds and retry this read with bounded backoff.",
  "metrics:read",
  z.object({ query: semanticQuerySchema }),
  (service, p) => service.querySemanticMetrics(p.query)
)
tool(
  "batch_metrics",
  "Run 1–40 read-only semantic queries sequentially against one consistent snapshot. Returns results in query order with shared snapshot metadata. Use discovered catalog members and source-specific time dimensions; on READ_BUSY, honor details.retryAfterSeconds and retry this read with bounded backoff.",
  "metrics:read",
  z.object({ queries: z.array(semanticQuerySchema).min(1).max(40) }),
  (service, p) => service.batchSemanticMetrics(p)
)
tool(
  "list_human_scores",
  "Read the project Human Score library and reusable collections. Human Scores are review criteria, separate from automated Scorers.",
  "reviews:read",
  z.object({}),
  (s) => s.humanScores.library()
)
tool(
  "get_human_score",
  "Read one Human Score definition, including type, numeric range or enum options and revision.",
  "reviews:read",
  z.object({ id }),
  (s, p) => s.humanScores.get(p.id)
)
tool(
  "create_human_score",
  "Create a reusable numeric, categorical (single or multiple choice), or text Human Score in this project.",
  "reviews:write",
  z.object({ score: humanScoreInputSchema }),
  (s, p) => s.humanScores.create(p.score)
)
tool(
  "update_human_score",
  "Update a Human Score with its current revision. Existing session and rating snapshots retain their definitions.",
  "reviews:write",
  z.object({ id, ...humanScoreUpdateSchema.shape }),
  (s, { id, ...p }) => s.humanScores.update(id, p)
)
tool(
  "get_human_score_collection",
  "Read an ordered collection with full Human Score definitions.",
  "reviews:read",
  z.object({ id }),
  (s, p) => s.humanScores.collection(p.id)
)
tool(
  "create_human_score_collection",
  "Create an ordered reusable collection of project Human Score IDs. Attach it to a review session using collectionId.",
  "reviews:write",
  humanScoreCollectionInputSchema,
  (s, p) => s.humanScores.createCollection(p)
)
tool(
  "update_human_score_collection",
  "Update an ordered Human Score collection. Attached sessions retain their snapshot.",
  "reviews:write",
  z.object({ id, ...humanScoreCollectionUpdateSchema.shape }),
  (s, { id, ...p }) => s.humanScores.updateCollection(id, p)
)
tool(
  "list_review_sessions",
  "List project review sessions with assignment, explicit AI labels, and separate human/AI completion counts. reviewedCount is total score completion, not human verification. Filters include name, status, and assigneeName.",
  "reviews:read",
  paging,
  (s, p) => s.reviews.list(p)
)
tool(
  "get_review_session",
  "Read a review session, its review prompt, and up to 500 trace items in their fixed playback order.",
  "reviews:read",
  z.object({ id }),
  (s, p) => s.reviews.get(p.id)
)
tool(
  "get_review_options",
  "List members who can be assigned to this project and the current reviewer identity. Use list_human_scores for the separate Human Score library.",
  "reviews:read",
  z.object({}),
  (s) => s.reviews.options()
)
tool(
  "create_review_session",
  "Create an ordered collection of traces for review. Use list_traces to find traces for a prompt, then pass their IDs in the desired order. The prompt field supplies review instructions. Optional collectionId attaches a snapshot of a Human Score collection to every trace. Does not run a model or execute the traces.",
  ["reviews:write", "traces:read"],
  reviewSessionInputSchema,
  (s, p) => s.reviews.create(p)
)
tool(
  "update_review_session",
  "Edit the review prompt, name, assigned project members, or collection using the current revision. Collection changes recalculate completion while retaining existing ratings and their provenance.",
  "reviews:write",
  z.object({ id, ...reviewSessionUpdateSchema.shape }),
  (s, { id, ...p }) => s.reviews.update(id, p)
)
tool(
  "get_review_item",
  "Read one review item's scores, notes, revision, trace ID and previous/next IDs. Use get_trace to inspect the actual prompt and output before reviewing.",
  "reviews:read",
  z.object({ sessionId: id, itemId: id }),
  (s, p) => s.reviews.item(p.sessionId, p.itemId)
)
tool(
  "export_review_items",
  "Export a bounded page of review items with complete scores, notes, annotations and trusted provenance. AI-labelled rows are not human-verified ground truth. Follow nextCursor to export the session.",
  "reviews:read",
  z.object({
    id,
    cursor: id.nullable().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  (s, { id, ...options }) => s.reviews.exportItems(id, options)
)
tool(
  "record_review",
  "Save AI-labelled scores, notes or annotations for one trace using an organization API key or user OAuth with reviews:write. Attribution is derived server-side from the authenticated principal; optional agent {name, model} is descriptive metadata only. Providing scores replaces the complete score set; include every required criterion to complete it. Omit scores for notes/annotations-only updates that preserve scores and completion. Use humanScoreId and humanScoreRevision from get_review_item or list_human_scores; null is an unanswered draft. Values must follow the rubric's numeric range, option values, multiple-choice array or text type. Requires expectedRevision from get_review_item; on conflict refetch before retrying. AI completion is separate from human verification and never updates dataset ground truth. Returns provenance, completionKind, humanVerified and nextItemId.",
  "reviews:write",
  z.object({ sessionId: id, itemId: id, ...recordReviewSchema.shape }).strict(),
  (s, { sessionId, itemId, ...p }) => s.reviews.record(sessionId, itemId, p)
)
tool(
  "list_scorer_libraries",
  "Discover supported evaluator libraries, pinned package/adapter versions, required arguments and model requirements. Create a type=library scorer with library {package, version, adapterVersion, evaluator, mappings, options}. Input mappings use trace or datasetItem dotted paths. Factuality uses the project's Vercel AI Gateway language model; deterministic evaluators need no provider.",
  "scorers:read",
  z.object({}),
  () =>
    tracerEffect(async () => ({
      libraries: scorerLibraries,
      defaultMappings: defaultLibraryMappings,
    }))
)
tool(
  "use_library_scorer",
  "Select a library evaluator using its default input mappings. Creates or reuses its saved project scorer without overwriting edits. Factuality defaults to openai/gpt-4.1-mini via the project's Gateway. Use the returned ID anywhere scorer IDs are accepted.",
  "scorers:write",
  z.object({ evaluator: z.enum(libraryEvaluatorIds) }).strict(),
  (service, input) => service.scorers.useLibrary(input)
)
tool(
  "list_scorers",
  "List saved LLM, JavaScript, Python and library scorer configurations.",
  "scorers:read",
  z.object({}),
  (service) => service.scorers.list()
)
tool(
  "get_scorer",
  "Read a scorer by ID.",
  "scorers:read",
  z.object({ id }),
  (service, p) => service.scorers.get(p.id)
)
tool(
  "create_scorer",
  "Create a scorer configuration; does not execute code or call a model.",
  "scorers:write",
  z.object({ scorer: scorerInputSchema }),
  (service, p) => service.scorers.save(p.scorer)
)
tool(
  "update_scorer",
  "Replace the complete scorer configuration by ID.",
  "scorers:write",
  z.object({
    id,
    scorer: scorerInputSchema,
    expectedRevision: z.number().int().positive(),
  }),
  (service, p) =>
    service.scorers.save(
      { ...p.scorer, expectedRevision: p.expectedRevision },
      p.id
    ),
  true
)
tool(
  "delete_scorer",
  "Permanently delete a scorer configuration.",
  "scorers:write",
  z.object({ id }),
  (service, p) => service.scorers.remove(p.id),
  true
)

tool(
  "list_views",
  "List custom eval-run table views.",
  "views:read",
  z.object({}),
  (service) => service.customViews.list("eval-runs")
)
tool(
  "get_view",
  "Read a custom eval-run view including its revision.",
  "views:read",
  z.object({ id }),
  (service, p) => service.customViews.get(p.id)
)
tool(
  "create_view",
  "Create a custom eval-run view.",
  "views:write",
  customViewInputSchema,
  (service, p) => service.customViews.create(p)
)
tool(
  "update_view",
  "Replace a custom view with revision conflict protection.",
  "views:write",
  customViewUpdateSchema.extend({ id }),
  (service, { id, ...p }) => service.customViews.update(id, p),
  true
)
tool(
  "delete_view",
  "Permanently delete a custom view at its expected revision.",
  "views:write",
  z.object({ id, expectedRevision: z.number().int().positive() }),
  (service, p) => service.customViews.delete(p.id, p.expectedRevision),
  true
)

tool(
  "list_saved_views",
  "List saved trace and eval-result selector views (distinct from custom eval-run views).",
  "views:read",
  paging.omit({ filter: true }),
  (service, p) => service.listSavedViews(p)
)
tool(
  "get_saved_view",
  "Read a saved selector view.",
  "views:read",
  z.object({ id }),
  (service, p) => service.getSavedView(p.id)
)
tool(
  "create_saved_view",
  "Create a saved trace or eval-result selector view.",
  "views:write",
  validation.createSavedView,
  (service, p) => service.createSavedView(validation.parseCreateSavedView(p))
)
tool(
  "update_saved_view",
  "Patch a saved selector view.",
  "views:write",
  z.object({ id, patch: validation.patchSavedView }),
  (service, p) =>
    service.patchSavedView(p.id, validation.parsePatchSavedView(p.patch)),
  true
)
tool(
  "delete_saved_view",
  "Permanently delete a saved selector view.",
  "views:write",
  z.object({ id }),
  (service, p) => service.deleteSavedView(p.id),
  true
)

tool(
  "list_datasets",
  "List datasets with cursor pagination.",
  "datasets:read",
  paging,
  (service, p) => service.listDatasets(p)
)
tool(
  "get_dataset",
  "Read a dataset summary and its first item page. Use list_dataset_items for more.",
  "datasets:read",
  z.object({ id }),
  (service, p) => service.getDataset(p.id)
)
tool(
  "list_dataset_items",
  "Read a bounded page of dataset items.",
  "datasets:read",
  paging.omit({ filter: true }).extend({ id }),
  (service, p) => service.listDatasetItems(p.id, p)
)
tool(
  "create_dataset",
  "Create a dataset.",
  "datasets:write",
  validation.createDataset,
  (service, p) => service.createDataset(validation.parseCreateDataset(p))
)
tool(
  "update_dataset",
  "Patch dataset name or description.",
  "datasets:write",
  z.object({ id, patch: validation.patchDataset }),
  (service, p) =>
    service.patchDataset(p.id, validation.parsePatchDataset(p.patch)),
  true
)
tool(
  "delete_dataset",
  "Permanently delete a dataset and its items. Datasets referenced by eval runs cannot be deleted.",
  "datasets:write",
  z.object({ id }),
  (service, p) => service.deleteDataset(p.id),
  true
)
tool(
  "create_dataset_item",
  "Add input, expected output, metadata, and an optional source trace to a dataset.",
  "datasets:write",
  z.object({ datasetId: id, item: validation.createDatasetItem }),
  (service, p) =>
    service.createDatasetItem(
      p.datasetId,
      validation.parseCreateDatasetItem(p.item)
    )
)
tool(
  "update_dataset_item",
  "Patch a dataset item.",
  "datasets:write",
  z.object({ id, patch: validation.patchDatasetItem }),
  (service, p) =>
    service.patchDatasetItem(p.id, validation.parsePatchDatasetItem(p.patch)),
  true
)
tool(
  "delete_dataset_item",
  "Permanently delete a dataset item.",
  "datasets:write",
  z.object({ id }),
  (service, p) => service.deleteDatasetItem(p.id),
  true
)
tool(
  "list_dashboards",
  "List saved dashboard configurations.",
  "dashboards:read",
  z.object({}),
  (service) => service.dashboards.list()
)
tool(
  "get_dashboard",
  "Read a dashboard, its widgets and current revision.",
  "dashboards:read",
  z.object({ id }),
  (service, p) => service.dashboards.get(p.id)
)
tool(
  "create_dashboard",
  "Create a dashboard with validated widget queries. Does not execute queries.",
  "dashboards:write",
  z.object({ config: dashboardInputSchema }),
  (service, p) => service.dashboards.create(p.config)
)
tool(
  "update_dashboard",
  "Replace dashboard configuration with revision conflict protection.",
  "dashboards:write",
  dashboardUpdateSchema.extend({ id }),
  (service, { id, ...input }) => service.dashboards.update(id, input),
  true
)
tool(
  "delete_dashboard",
  "Permanently delete a dashboard at its expected revision.",
  "dashboards:write",
  z.object({ id, expectedRevision: z.number().int().positive() }),
  (service, p) => service.dashboards.delete(p.id, p.expectedRevision),
  true
)

tool(
  "list_traces",
  'Filter and page trace summaries. Filter syntax includes status = "errored", name contains "agent", and startedAt >= "-24h". Use get_trace for full evidence.',
  "traces:read",
  paging.extend({ sessionId: id.optional() }),
  (s, p) => s.listTraces(p)
)
tool(
  "get_trace",
  "Get complete trace evidence including spans and scores; capped at 8 MiB. Use paged child tools for larger traces.",
  "traces:read",
  z.object({ id }),
  (s, p) => s.getTraceArtifact(p.id)
)
tool(
  "list_trace_spans",
  "Page spans in a trace in start-time order.",
  "traces:read",
  paging.omit({ filter: true }).extend({ id }),
  (s, p) => s.listTraceSpans(p.id, p)
)
tool(
  "get_span_path",
  "Get the ancestor path of a span within its trace.",
  "traces:read",
  z.object({ traceId: id, spanId: id }),
  (s, p) => s.getTraceSpanPath(p.traceId, p.spanId)
)
tool(
  "list_trace_scores",
  "Page the scores attached to a trace.",
  "traces:read",
  paging.omit({ filter: true }).extend({ id }),
  (s, p) => s.listTraceScores(p.id, p)
)
tool(
  "list_sessions",
  "Filter and page sessions; use list_traces with sessionId to page their traces.",
  "traces:read",
  paging,
  (s, p) => s.listSessions(p)
)
tool(
  "get_session",
  "Read a session and its initial trace page.",
  "traces:read",
  z.object({ id }),
  (s, p) => s.getSession(p.id)
)
tool(
  "list_scorer_versions",
  "Page immutable scorer version metadata. Use get_scorer_version to retrieve executable configuration.",
  "scorers:read",
  paging.omit({ filter: true }).extend({ id }),
  (s, p) => s.agent.listVersions(p.id, p)
)
tool(
  "get_scorer_version",
  "Read an immutable executable version belonging to a scorer.",
  "scorers:read",
  z.object({ id, versionId: id }),
  (s, p) => s.agent.getVersion(p.id, p.versionId)
)
const runtimeSelection = z.object({
  scorerIds: z.array(id).min(1).max(10),
  evaluatorVersionIds: z.record(id, id).optional(),
})
tool(
  "check_scorer_runtime",
  "Read-only configuration diagnostics for selected pinned scorers. Does not call providers or launch sandboxes, and does not establish connectivity or successful execution. Use probe_scorer_runtime explicitly for a bounded, potentially billable representative execution.",
  "scorers:read",
  runtimeSelection,
  (s, p) => s.agent.checkScorerRuntime(p)
)
tool(
  "probe_scorer_runtime",
  "Explicitly execute up to 3 pinned scorers on one representative trace/span or dataset case using their actual provider/model/sandbox. May incur usage and retain execution spans. Reports configuration, connectivity, and execution separately; creates no saved evaluation. Use start_eval_run for multi-case calibration.",
  ["scorers:read", "scorers:write", "traces:read", "datasets:read"],
  runtimeSelection
    .extend({
      scorerIds: z.array(id).min(1).max(3),
      traceId: id,
      spanId: id.optional(),
      datasetId: id.optional(),
      datasetItemId: id.optional(),
      datasetVersionId: id.optional(),
    })
    .superRefine((p, ctx) => {
      if (
        Boolean(p.datasetId) !== Boolean(p.datasetItemId) ||
        (p.datasetVersionId && !p.datasetId)
      )
        ctx.addIssue({
          code: "custom",
          message: "Dataset context requires datasetId and datasetItemId.",
        })
    }),
  (s, p) => s.agent.probeScorerRuntime(p)
)
tool(
  "test_scorer",
  "Preview a saved, pinned, or inline scorer on trace or selected span evidence. Does not create a saved evaluation run or score result; a scorer execution span is retained. Use start_eval_run for a named persistent evaluation. LLM scorers may incur model cost. Optional dataset context requires both datasetId and datasetItemId.",
  ["scorers:read", "scorers:write", "traces:read", "datasets:read"],
  z
    .object({
      traceId: id,
      spanId: id.optional(),
      scorerId: id.optional(),
      versionId: id.optional(),
      scorer: scorerInputSchema.optional(),
      datasetId: id.optional(),
      datasetItemId: id.optional(),
      datasetVersionId: id.optional(),
    })
    .superRefine((p, ctx) => {
      if (
        Boolean(p.scorer) === Boolean(p.scorerId) ||
        (p.versionId && !p.scorerId)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Provide either scorer or scorerId; versionId requires scorerId.",
        })
      if (
        Boolean(p.datasetId) !== Boolean(p.datasetItemId) ||
        (p.datasetVersionId && !p.datasetId)
      )
        ctx.addIssue({
          code: "custom",
          message: "Dataset context requires datasetId and datasetItemId.",
        })
    }),
  (s, p) => s.agent.testScorer(p)
)
tool(
  "list_eval_runs",
  "Filter and page evaluation run summaries, including saved groups (type/name/version) and groupsResolvedAt. Filter membership with workflow = 'Name' or agent = 'Name'; multiple memberships are supported. Null groupsResolvedAt means historical attribution has not been resolved; an empty groups array with a timestamp means unassigned.",
  "evals:read",
  paging,
  (s, p) => s.listEvalRuns(p)
)
tool(
  "list_eval_run_groups",
  "Group all matching evaluation runs by saved workflow or agent membership, with exact run counts and cursor-paged groups. A mixed run can belong to several groups. Each returned filter can be passed to list_eval_runs to page that group's runs. Unresolved historical runs are separate from resolved, unassigned runs.",
  "evals:read",
  paging.extend({ groupBy: z.enum(["workflow", "agent"]) }),
  (s, p) => s.listEvalRunGroups(p)
)
tool(
  "cancel_eval_run",
  "Stop scheduling work and fence late result writes. Already dispatched application calls may finish; retained outputs and judgments are preserved. Cancelled runs cannot be recovered.",
  ["evals:read", "evals:write"],
  z.object({ id }),
  (s, p) => s.cancelEvalRun(p.id)
)
tool(
  "recover_eval_run",
  "Resume unfinished cases after a worker lease expires, or retry scoring errors on retained evidence. Reuses completed judgments and durable app/bridge output. Never re-dispatches an uncertain app call. Live workers and cancelled runs reject recovery.",
  [
    "evals:read",
    "evals:write",
    "traces:read",
    "datasets:read",
    "scorers:read",
    "apps:read",
  ],
  z.object({ id }),
  (s, p) => s.recoverEvalRun(p.id)
)
tool(
  "get_eval_run",
  "Read a run's status, worker/stage progress, per-case execution errors, resolved evaluatorVersionIds and one lightweight result page with exact frozen inputs/outputs. Frozen and scorer spans are omitted by default; use get_eval_target with the run id and a row id for full case evidence, or opt in with includeEvidence. Batches shrink automatically to fit 8 MiB; continue with nextCursor, even if fewer rows than requested are returned.",
  "evals:read",
  paging
    .omit({ filter: true })
    .extend({ id, includeEvidence: z.boolean().default(false) }),
  (s, p) => s.getEvalRun(p.id, p)
)
tool(
  "get_eval_target",
  "Read one evaluation case's complete frozen evidence, scorer execution spans and results, capped at 8 MiB. Pass the run id and targetId from get_eval_run rows[].id or a comparison row's id. Does not substitute the current live trace for saved evidence.",
  "evals:read",
  z.object({ id, targetId: id }),
  (s, p) => s.getEvalRunTarget(p.id, p.targetId)
)
tool(
  "start_eval_run",
  "Create a named, persistent asynchronous evaluation and return its URL promptly. Execution completion, quality failures, and infrastructure errors are distinct. Choose trace IDs, a dataset (optionally datasetVersionId), or sourceRunId to re-score frozen evidence without calling the app again. Connected dataset runs accept promptOverrides keyed by managed prompt slug with optional version and model; all published prompt defaults are frozen at run creation, including lazy discovery. These are separate from inputs and expected outputs, forbidden for re-scoring, and part of requestKey identity. Connected dataset runs accept inputOverrides: shallow merge over each object case input, override keys win, nested values replace whole values and null is literal. The effective app input and overrides are frozen; dataset inputs and expected outputs remain unchanged. Overrides are forbidden for re-scoring and included in requestKey identity. Use parentRunId to execute the app again on a prior run's frozen cases/references, inheriting its settings and resolving latest prompts/scorers by default; optional overrides change those settings. useRecordedVersions=true holds recorded prompt/scorer revisions for reproduction or comparison. sourceRunId only re-scores saved outputs; its judges also default to latest. Each run records resolved versions, parentRunId and configurationChanges. Pin individual scorers with evaluatorVersionIds. Supply a stable requestKey: retries with the same key and inputs return the same run. Connected runs and LLM scorers may incur cost. Poll get_eval_run and use gate_eval_run when terminal.",
  ["evals:write", "evals:read", "traces:read", "datasets:read", "scorers:read"],
  validation.createEvalRun.extend({ requestKey: id }),
  (s, p) =>
    s.agent.startEval({
      ...validation.parseCreateEvalRun(
        Object.fromEntries(
          Object.entries(p).filter(([key]) => key !== "requestKey")
        )
      ),
      requestKey: p.requestKey,
    })
)
tool(
  "compare_eval_runs",
  "Compare runs and their resolved configurationChanges, separating extractor changes from judge-version changes. Changed judges remain viewable but cannot pass a baseline quality gate. Use exact frozen inputs/outputs, matching dataset item, trace, then unique input. Full spans are omitted by default; use get_eval_target to inspect a case or opt in with includeEvidence. Batches shrink automatically to fit 8 MiB; always continue with nextOffset instead of assuming a fixed page size.",
  "evals:read",
  z.object({
    leftId: id,
    rightId: id,
    offset: z.number().int().min(0).max(100_000).default(0),
    includeEvidence: z.boolean().default(false),
  }),
  (s, p) => s.compareEvalRuns(p.leftId, p.rightId, p.offset, p.includeEvidence)
)
tool(
  "gate_eval_run",
  "Evaluate CI thresholds across ALL results. Fails closed on nonterminal, empty, missing or unscored results. Optional baseline checks mean-score regression. Returns passed plus reasons; CLI exits 2 on failure.",
  "evals:read",
  z.object({
    id,
    minScore: z.number().min(0).max(1).default(0),
    minPassRate: z.number().min(0).max(1).default(1),
    maxErrors: z.number().int().min(0).default(0),
    allowUnscored: z.boolean().default(false),
    baselineId: id.optional(),
    maxRegression: z.number().min(0).max(1).default(0),
  }),
  (s, p) => s.agent.gateEval(p)
)
tool(
  "promote_spans",
  "Preview or atomically promote 1–100 exact production spans into dataset cases. Defaults to preview=true. Captures only the selected subtree with provenance; observed output is separate and expectedOutput defaults to null. mappedInput is explicit app input, never inferred from prompt text. Save with preview=false and the preview's expectedEvidenceHash. No new production traces are created.",
  ["datasets:read", "datasets:write", "traces:read"],
  promoteSpansSchema,
  (s, p) => s.agent.promoteSpans(p)
)
tool(
  "bulk_dataset_items",
  "Atomically create, update and delete at most 100 dataset items. Any failure rolls back the batch. expectedHash optionally guards the content hash returned by a snapshot or prior bulk edit.",
  "datasets:write",
  z
    .object({
      datasetId: id,
      expectedHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      create: z.array(validation.createDatasetItem).max(100).optional(),
      update: z
        .array(z.object({ id, patch: validation.patchDatasetItem }))
        .max(100)
        .optional(),
      delete: z.array(id).max(100).optional(),
    })
    .superRefine((p, ctx) => {
      const n =
        (p.create?.length ?? 0) +
        (p.update?.length ?? 0) +
        (p.delete?.length ?? 0)
      if (n < 1 || n > 100)
        ctx.addIssue({
          code: "custom",
          message: "A bulk edit requires 1–100 changes.",
        })
    }),
  (s, p) => s.agent.bulkDataset(p),
  true
)
tool(
  "create_dataset_snapshot",
  "Freeze dataset inputs, expected outputs, metadata and captured span evidence as immutable per-case content. Aggregate captured evidence can exceed 8 MiB; item reads remain bounded to 8 MiB per page. Legacy trace references resolve evidence at evaluation start. Identical content returns the existing snapshot. Pass its id as datasetVersionId to an evaluation.",
  ["datasets:read", "datasets:write"],
  z.object({
    datasetId: id,
    label: z.string().trim().min(1).max(200).optional(),
  }),
  (s, p) => s.agent.createSnapshot(p.datasetId, p.label)
)
tool(
  "list_dataset_snapshots",
  "Page immutable dataset snapshot metadata.",
  "datasets:read",
  paging.omit({ filter: true }).extend({ datasetId: id }),
  (s, p) => s.agent.listSnapshots(p.datasetId, p)
)
tool(
  "get_dataset_snapshot",
  "Read a frozen dataset and one immutable item page. Pages shrink to fit 8 MiB; continue with nextCursor even when fewer rows than requested are returned.",
  "datasets:read",
  paging.omit({ filter: true }).extend({ datasetId: id, versionId: id }),
  (s, p) => s.agent.getSnapshot(p.datasetId, p.versionId, p)
)
tool(
  "preview_dashboard",
  "Execute stored dashboard widget queries with their saved date windows. Returns configuration and ordered query results. Each batch of at most 40 expanded queries shares a snapshot; larger previews use multiple snapshots, not one dashboard-wide snapshot. On READ_BUSY, honor details.retryAfterSeconds and retry this read with bounded backoff.",
  ["dashboards:read", "metrics:read"],
  z.object({ id }),
  (s, p) => s.agent.previewDashboard(p.id)
)
tool(
  "get_saved_view_data",
  "Execute a saved selector view and return a bounded row page. Eval-result views can be restricted to runId.",
  ["views:read", "traces:read", "evals:read"],
  z.object({
    id,
    runId: id.optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  (s, p) => s.getSavedViewData(p.id, p)
)
tool(
  "list_report_templates",
  "List query-backed MDX report starters. get_report_template returns an editable MDX document with named sources.",
  "dashboards:read",
  z.object({}),
  () =>
    tracerEffect(async () =>
      reportTemplates.map(({ id, name, description }) => ({
        id,
        name,
        description,
      }))
    )
)
tool(
  "get_report_template",
  "Get an MDX starter document with concrete named queries and absolute dates. asOf sets the query window end, not a historical database snapshot. Review sources and compose MDX before creating a report.",
  "dashboards:read",
  z.object({ id, asOf: z.iso.datetime({ offset: true }).optional() }),
  (_s, p) =>
    tracerEffect(async () => {
      const template = reportTemplates.find((template) => template.id === p.id)
      if (!template)
        throw invalid("Unknown report template; use list_report_templates.")
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        document: dashboardReportDocument(template.create(p.asOf ? new Date(p.asOf) : new Date())),
      }
    })
)
tool(
  "list_reports",
  "List saved frozen reports in the current project, newest first. Use get_report with the project-local report number to read its config and captured data.",
  ["dashboards:read", "metrics:read"],
  z.object({}),
  (s) => s.reports.list()
)
tool(
  "get_report",
  "Read a saved report by its project-local number, including its text, widget config and frozen query results. This does not query live metric data.",
  ["dashboards:read", "metrics:read"],
  z.object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  (s, p) => s.reports.get(p.number)
)
tool(
  "create_report",
  "Create a private MDX report draft from name, mdx, named sources and optional evidence bindings. Start with get_report_authoring_guide for the workflow, paired-file recipe, exact component props and supported Tailwind utilities. Component source props reference named queries. No JavaScript execution, imports or arbitrary CSS. Use literal JSON props. All queries capture complete results together (40 queries, 5000 rows/query, 8 MiB); sources reused by components are deduplicated. Validate with validate_report first. Creation requires a stable UUID creationKey; identical retries return the original. update_report preserves captured data unless refresh is explicit. publish_report locks the reviewed revision; sharing remains a separate action.",
  ["dashboards:write", "metrics:read"],
  reportInputSchema,
  (s, p) => s.reports.create(p)
)
tool(
  "get_report_recipe",
  "Get the MDX evaluation-story recipe: editorial guidance, report.mdx and report.data.json starter files, and the agent workflow. Use get_report_components for typed props. The recipe is optional guidance, not a fixed layout.",
  "dashboards:read",
  z.object({}),
  () => tracerEffect(async () => evaluationStoryRecipe)
)
tool(
  "get_report_authoring_guide",
  "Get the complete MDX report authoring contract: document shape, source and binding model, component examples, limits, validation scope and the ordered workflow from discovery through private draft review and optional publication. Use this before writing a report; it does not query data or save a report.",
  "dashboards:read",
  z.object({}),
  () => tracerEffect(async () => reportAuthoringGuide())
)
tool("get_report_components", "Discover MDX component names, exact prop schemas, child support and supported static Tailwind classes.", "dashboards:read", z.object({}), () => tracerEffect(async()=>reportComponentsCatalog()))
tool("validate_report", "Validate MDX, component props, sources, evidence and data shapes without saving or consuming a report number. With number and revision, validates against that report's frozen evidence; refresh:true explicitly queries fresh data. Without number, performs a fresh capture for validation. Returns structural, data and server-render checks; browser visual and responsive review remain separate. Does not publish or share.", ["dashboards:read", "metrics:read"], reportValidationSchema, (s,p)=>s.reports.validate(p))
tool("update_report", "Edit a private MDX draft using number, revision and the complete document {name, description, mdx, sources, bindings}. Source and layout edits reuse frozen evidence. Changing query definitions or adding a visualization requiring extra aggregates requires refresh:true; review the refreshed data before publishing. Published reports reject edits.", ["dashboards:write", "metrics:read"], reportUpdateSchema, (s, p) => s.reports.update(p))
tool("publish_report", "Publish the reviewed draft at its current revision. Locks the composition and captured evidence without querying live data. Publication alone stays private; use set_report_sharing only when public access is intended.", ["dashboards:write", "metrics:read"], reportPublishSchema, (s, p) => s.reports.publish(p))
tool("set_report_sharing", "Explicitly enable or revoke an anonymous public link for a published report. Anyone with the returned publicPath can read all captured report rows and expanded evidence without signing in. Never enable without authorization to share that report publicly. Revocation invalidates the link; re-enabling generates a new one.", ["dashboards:write", "metrics:read"], reportShareSchema, (s, p) => s.reports.share(p))
tool("clone_report", "Create a new private draft copy of a report, preserving the exact captured evidence without rerunning queries. Uses a UUID creationKey for idempotent retries; the original and any public link stay unchanged.", ["dashboards:write", "metrics:read"], reportCloneSchema, (s, p) => s.reports.clone(p))
for (const [kind, scope] of Object.entries({
  trace: "traces:read",
  session: "traces:read",
  dataset: "datasets:read",
  scorer: "scorers:read",
  eval: "evals:read",
  dashboard: "dashboards:read",
  view: "views:read",
  report: ["dashboards:read", "metrics:read"],
}) as [
  (
    | "trace"
    | "session"
    | "dataset"
    | "scorer"
    | "eval"
    | "dashboard"
    | "view"
    | "report"
  ),
  WorkspaceScope | WorkspaceScope[],
][]) {
  tool(
    `resolve_${kind}`,
    "Resolve an exact ID or supported exact name/slug in the current project and return its canonical URL. Reports also resolve by project-local number. Ambiguous names fail. Some objects have collection links because the UI has no detail route.",
    scope,
    z.object({ key: z.string().min(1).max(500) }),
    (s, p) => s.agent.resolveObject(kind, p.key)
  )
}

export const agentOperations: readonly AgentOperation[] = operations
export function findAgentOperation(name: string) {
  return agentOperations.find((op) => op.name === name)
}

tool(
  "describe_agent_operations",
  "Discover agent operation names, required permissions and JSON input schemas shared by MCP and CLI.",
  [],
  z.object({ name: z.string().optional() }),
  (_s, p) =>
    tracerEffect(async () => {
      const selected = p.name
        ? operations.filter((op) => op.name === p.name)
        : operations
      if (!selected.length) throw invalid("Unknown agent operation.")
      return selected.map((op) => ({
        name: op.name,
        description: op.description,
        scopes: op.scopes,
        inputSchema: z.toJSONSchema(op.schema, { io: "input" }) as Record<
          string,
          unknown
        >,
      }))
    })
)

import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

// The application serializes documents; PostgreSQL stores and indexes native JSONB.
const jsonDocument = customType<{ data: string; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => value,
  fromDriver: (value) => JSON.stringify(value),
})
const analyticalFacts = () => ({
  durationMs: doublePrecision("duration_ms").generatedAlwaysAs(
    sql`case when status in ('completed','errored','cancelled') and ended_at_ms >= started_at_ms then ended_at_ms-started_at_ms end`
  ),
  costUsd: doublePrecision("cost_usd").generatedAlwaysAs(
    sql`datool_cost(attributes_json)`
  ),
  reportedCostUsd: doublePrecision("reported_cost_usd").generatedAlwaysAs(
    sql`datool_number(attributes_json,'cost.usd')`
  ),
  costStatus: text("cost_status").generatedAlwaysAs(
    sql`attributes_json->>'cost.status'`
  ),
  costPresent: boolean("cost_present").generatedAlwaysAs(
    sql`attributes_json ? 'cost.usd'`
  ),
  inputCostUsd: doublePrecision("input_cost_usd").generatedAlwaysAs(
    sql`datool_breakdown(attributes_json,'inputUSD')`
  ),
  outputCostUsd: doublePrecision("output_cost_usd").generatedAlwaysAs(
    sql`datool_breakdown(attributes_json,'outputUSD')`
  ),
  cacheReadCostUsd: doublePrecision("cache_read_cost_usd").generatedAlwaysAs(
    sql`datool_breakdown(attributes_json,'cacheReadsUSD')`
  ),
  cacheWriteCostUsd: doublePrecision("cache_write_cost_usd").generatedAlwaysAs(
    sql`datool_breakdown(attributes_json,'cacheWritesUSD')`
  ),
  inputTokens: doublePrecision("input_tokens").generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'usage.input_tokens',true),datool_number(attributes_json,'gen_ai.usage.input_tokens',true),datool_number(attributes_json,'ai.usage.inputTokens',true))`
  ),
  outputTokens: doublePrecision("output_tokens").generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'usage.output_tokens',true),datool_number(attributes_json,'gen_ai.usage.output_tokens',true),datool_number(attributes_json,'ai.usage.outputTokens',true))`
  ),
  reportedTotalTokens: doublePrecision(
    "reported_total_tokens"
  ).generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'usage.total_tokens',true),datool_number(attributes_json,'ai.usage.totalTokens',true))`
  ),
  cachedTokens: doublePrecision("cached_tokens").generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'usage.cache_read_tokens',true),datool_number(attributes_json,'gen_ai.usage.cache_read.input_tokens',true),datool_number(attributes_json,'ai.usage.inputTokenDetails.cacheReadTokens',true),datool_number(attributes_json,'ai.usage.cachedInputTokens',true))`
  ),
  writtenTokens: doublePrecision("written_tokens").generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'usage.cache_write_tokens',true),datool_number(attributes_json,'gen_ai.usage.cache_creation.input_tokens',true))`
  ),
  ttftMs: doublePrecision("ttft_ms").generatedAlwaysAs(
    sql`coalesce(datool_number(attributes_json,'ttft.ms'),datool_number(attributes_json,'latency.ttft_ms'),datool_number(attributes_json,'gen_ai.latency.time_to_first_token')*1000,datool_number(attributes_json,'ai.response.msToFirstChunk'),datool_number(attributes_json,'ai.stream.msToFirstChunk'))`
  ),
})

const projects = pgTable("project", { id: text("id").primaryKey() })
const projectScope = () => ({
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
})

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("sessions_project_id_id_idx").on(t.projectId, t.id),
    index("sessions_project_page_idx").on(t.projectId, t.updatedAt, t.id),
    index("sessions_project_updated_at_idx").on(t.projectId, t.updatedAt),
  ]
)

export const traces = pgTable(
  "traces",
  {
    id: text("id").primaryKey(),
    ...analyticalFacts(),
    ...projectScope(),
    sessionId: text("session_id"),
    name: text("name").notNull(),
    operation: text("operation").notNull(),
    groupType: text("group_type"),
    groupName: text("group_name"),
    groupVersion: text("group_version"),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    attributesJson: jsonDocument("attributes_json").notNull().default("{}"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    // Maintained by the PostgreSQL timestamp trigger; retain original API text.
    startedAtMs: doublePrecision("started_at_ms"),
    endedAtMs: doublePrecision("ended_at_ms"),
    endedAt: text("ended_at"),
  },
  (t) => [
    uniqueIndex("traces_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
      name: "traces_project_session_fk",
    }).onDelete("no action"),
    index("traces_project_session_id_idx").on(t.projectId, t.sessionId),
    index("traces_project_started_at_idx").on(t.projectId, t.startedAt),
    index("traces_project_started_ms_idx").on(t.projectId, t.startedAtMs),
    index("traces_project_group_time_idx")
      .on(t.projectId, t.groupType, t.startedAtMs)
      .where(sql`${t.groupName} is not null`),
    index("traces_project_group_name_time_idx")
      .on(t.projectId, t.groupType, t.groupName, t.startedAtMs)
      .where(sql`${t.groupName} is not null`),
    check(
      "trace_group_valid",
      sql`(${t.groupType} is null and ${t.groupName} is null and ${t.groupVersion} is null) or (${t.groupType} is not null and ${t.groupType} in ('agent','workflow') and ${t.groupName} is not null and length(btrim(${t.groupName})) between 1 and 200 and ${t.groupName}=btrim(${t.groupName}) and (${t.groupVersion} is null or (length(btrim(${t.groupVersion})) between 1 and 200 and ${t.groupVersion}=btrim(${t.groupVersion}))))`
    ),
    index("traces_project_page_idx").on(t.projectId, t.startedAt, t.id),
    index("traces_project_session_page_idx").on(
      t.projectId,
      t.sessionId,
      t.startedAt,
      t.id
    ),
  ]
)

export const spans = pgTable(
  "spans",
  {
    id: text("id").primaryKey(),
    ...analyticalFacts(),
    ...projectScope(),
    traceId: text("trace_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    groupType: text("group_type"),
    groupName: text("group_name"),
    groupVersion: text("group_version"),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    attributesJson: jsonDocument("attributes_json").notNull().default("{}"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    // Maintained by the PostgreSQL timestamp trigger; retain original API text.
    startedAtMs: doublePrecision("started_at_ms"),
    endedAtMs: doublePrecision("ended_at_ms"),
    endedAt: text("ended_at"),
  },
  (t) => [
    uniqueIndex("spans_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("spans_project_trace_id_id_idx").on(
      t.projectId,
      t.traceId,
      t.id
    ),
    foreignKey({
      columns: [t.projectId, t.traceId],
      foreignColumns: [traces.projectId, traces.id],
      name: "spans_project_trace_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.traceId, t.parentId],
      foreignColumns: [t.projectId, t.traceId, t.id],
      name: "spans_project_parent_fk",
    }).onDelete("set null"),
    index("spans_project_trace_id_idx").on(t.projectId, t.traceId),
    index("spans_project_parent_id_idx").on(t.projectId, t.parentId),
    index("spans_project_group_time_idx")
      .on(t.projectId, t.groupType, t.startedAtMs)
      .where(sql`${t.groupName} is not null`),
    index("spans_project_group_name_time_idx")
      .on(t.projectId, t.groupType, t.groupName, t.startedAtMs)
      .where(sql`${t.groupName} is not null`),
    check(
      "span_group_valid",
      sql`(${t.groupType} is null and ${t.groupName} is null and ${t.groupVersion} is null) or (${t.groupType} is not null and ${t.groupType} in ('agent','workflow') and ${t.groupName} is not null and length(btrim(${t.groupName})) between 1 and 200 and ${t.groupName}=btrim(${t.groupName}) and (${t.groupVersion} is null or (length(btrim(${t.groupVersion})) between 1 and 200 and ${t.groupVersion}=btrim(${t.groupVersion}))))`
    ),
    index("spans_project_started_ms_idx").on(t.projectId, t.startedAtMs),
  ]
)

export const datasetFolders = pgTable(
  "dataset_folders",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("dataset_folders_project_name_idx").on(t.projectId, t.name),
    index("dataset_folders_parent_idx").on(t.projectId, sql`regexp_replace(${t.name}, '[^/]+$', '')`, t.name, t.id),
  ]
)

export const datasets = pgTable(
  "datasets",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    description: text("description"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    fieldSchemasJson: text("field_schemas_json").notNull().default("{}"),
    versionId: text("version_id").notNull().default(sql`gen_random_uuid()::text`),
    revision: integer("revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("datasets_project_id_id_idx").on(t.projectId, t.id),
    index("datasets_project_page_idx").on(t.projectId, t.updatedAt, t.id),
    uniqueIndex("datasets_project_name_idx").on(t.projectId, t.name),
    index("datasets_parent_idx").on(t.projectId, sql`regexp_replace(${t.name}, '[^/]+$', '')`, t.name, t.id),
  ]
)

export const datasetItems = pgTable(
  "dataset_items",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    datasetId: text("dataset_id").notNull(),
    versionId: text("version_id").notNull().default(sql`gen_random_uuid()::text`),
    inputJson: text("input_json").notNull(),
    expectedOutputJson: text("expected_output_json"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    sourceTraceId: text("source_trace_id"),
    sourceSpanId: text("source_span_id"),
    sourceSpanEvidenceJson: text("source_span_evidence_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("dataset_items_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.datasetId],
      foreignColumns: [datasets.projectId, datasets.id],
      name: "dataset_items_project_dataset_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.sourceTraceId],
      foreignColumns: [traces.projectId, traces.id],
      name: "dataset_items_project_trace_fk",
    }).onDelete("no action"),
    index("dataset_items_project_page_idx").on(
      t.projectId,
      t.datasetId,
      t.createdAt,
      t.id
    ),
    index("dataset_items_project_dataset_id_idx").on(t.projectId, t.datasetId),
  ]
)

export const evaluators = pgTable(
  "evaluators",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    description: text("description"),
    activeVersionId: text("active_version_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("evaluators_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("evaluators_project_name_idx").on(t.projectId, t.name),
  ]
)

export const evaluatorVersions = pgTable(
  "evaluator_versions",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    evaluatorId: text("evaluator_id").notNull(),
    version: integer("version").notNull(),
    language: text("language").notNull(),
    code: text("code").notNull(),
    configJson: text("config_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("evaluator_versions_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.evaluatorId],
      foreignColumns: [evaluators.projectId, evaluators.id],
      name: "evaluator_versions_project_evaluator_fk",
    }).onDelete("cascade"),
    uniqueIndex("evaluator_versions_project_evaluator_version_idx").on(
      t.projectId,
      t.evaluatorId,
      t.version
    ),
  ]
)

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    name: text("name"),
    datasetId: text("dataset_id"),
    status: text("status").notNull(),
    createdAtMs: doublePrecision("created_at_ms"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    groupsResolvedAt: text("groups_resolved_at"),
  },
  (t) => [
    uniqueIndex("eval_runs_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.datasetId],
      foreignColumns: [datasets.projectId, datasets.id],
      name: "eval_runs_project_dataset_fk",
    }).onDelete("no action"),
    index("eval_runs_project_page_idx").on(t.projectId, t.createdAt, t.id),
    index("eval_runs_project_time_idx").on(t.projectId, t.createdAtMs),
    index("eval_runs_project_created_at_idx").on(t.projectId, t.createdAt),
    index("eval_runs_project_status_idx").on(t.projectId, t.status),
  ]
)

export const evalRunEvaluators = pgTable(
  "eval_run_evaluators",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    runId: text("run_id").notNull(),
    evaluatorId: text("evaluator_id").notNull(),
    evaluatorVersionId: text("evaluator_version_id").notNull(),
  },
  (t) => [
    uniqueIndex("eval_run_evaluators_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.runId],
      foreignColumns: [evalRuns.projectId, evalRuns.id],
      name: "eval_run_evaluators_project_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.evaluatorId],
      foreignColumns: [evaluators.projectId, evaluators.id],
      name: "eval_run_evaluators_project_evaluator_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.evaluatorVersionId],
      foreignColumns: [evaluatorVersions.projectId, evaluatorVersions.id],
      name: "eval_run_evaluators_project_version_fk",
    }).onDelete("restrict"),
    uniqueIndex("eval_run_evaluators_project_run_evaluator_idx").on(
      t.projectId,
      t.runId,
      t.evaluatorId
    ),
  ]
)

export const evalRunTargets = pgTable(
  "eval_run_targets",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    runId: text("run_id").notNull(),
    traceId: text("trace_id").notNull(),
    datasetItemId: text("dataset_item_id"),
    stage: text("stage").notNull().default("legacy"),
    progressAt: timestamp("progress_at", { withTimezone: true }).notNull().defaultNow(),
    executionError: text("execution_error"),
    ordinal: integer("ordinal").notNull(),
    snapshotJson: text("snapshot_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("eval_run_targets_project_id_id_idx").on(t.projectId, t.id),
    uniqueIndex("eval_targets_project_run_id_idx").on(t.projectId, t.runId, t.id),
    foreignKey({
      columns: [t.projectId, t.runId],
      foreignColumns: [evalRuns.projectId, evalRuns.id],
      name: "eval_run_targets_project_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.traceId],
      foreignColumns: [traces.projectId, traces.id],
      name: "eval_run_targets_project_trace_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.datasetItemId],
      foreignColumns: [datasetItems.projectId, datasetItems.id],
      name: "eval_run_targets_project_item_fk",
    }).onDelete("no action"),
    uniqueIndex("eval_run_targets_project_run_ordinal_idx").on(
      t.projectId,
      t.runId,
      t.ordinal
    ),
  ]
)

export const evalResults = pgTable(
  "eval_results",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    runId: text("run_id").notNull(),
    targetId: text("target_id"),
    traceId: text("trace_id").notNull(),
    datasetItemId: text("dataset_item_id"),
    evaluatorId: text("evaluator_id").notNull(),
    evaluatorVersionId: text("evaluator_version_id").notNull(),
    score: doublePrecision("score"),
    passed: boolean("passed"),
    status: text("status").notNull(),
    reasoning: text("reasoning"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    eventAtMs: doublePrecision("event_at_ms"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("eval_results_project_time_idx").on(t.projectId, t.eventAtMs),
    index("eval_results_target_evaluator_idx").on(t.projectId, t.runId, t.targetId, t.evaluatorId),
    foreignKey({ columns: [t.projectId, t.runId, t.targetId], foreignColumns: [evalRunTargets.projectId, evalRunTargets.runId, evalRunTargets.id], name: "eval_results_project_run_target_fk" }).onDelete("cascade"),
    uniqueIndex("eval_results_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.runId],
      foreignColumns: [evalRuns.projectId, evalRuns.id],
      name: "eval_results_project_run_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.traceId],
      foreignColumns: [traces.projectId, traces.id],
      name: "eval_results_project_trace_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.datasetItemId],
      foreignColumns: [datasetItems.projectId, datasetItems.id],
      name: "eval_results_project_item_fk",
    }).onDelete("no action"),
    foreignKey({
      columns: [t.projectId, t.evaluatorId],
      foreignColumns: [evaluators.projectId, evaluators.id],
      name: "eval_results_project_evaluator_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.evaluatorVersionId],
      foreignColumns: [evaluatorVersions.projectId, evaluatorVersions.id],
      name: "eval_results_project_version_fk",
    }).onDelete("restrict"),
    index("eval_results_project_run_id_idx").on(t.projectId, t.runId),
  ]
)

export const scoreImports = pgTable(
  "score_imports",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("score_imports_project_id_id_key").on(t.projectId, t.id),
    index("score_imports_project_page_idx").on(t.projectId, t.createdAt, t.id),
    check(
      "score_imports_status_check",
      sql`${t.status} in ('imported','unsupported','unresolved')`
    ),
  ]
)

export const scores = pgTable(
  "scores",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    traceId: text("trace_id"),
    evalResultId: text("eval_result_id"),
    evaluatorId: text("evaluator_id"),
    spanId: text("span_id"),
    sessionId: text("session_id"),
    evalRunId: text("eval_run_id"),
    importId: text("import_id"),
    external:
      jsonb("external_json").$type<
        import("@/src/lib/tracer/imported-scores").ImportedScore
      >(),
    name: text("name").notNull(),
    value: doublePrecision("value"),
    status: text("status").notNull(),
    eventAtMs: doublePrecision("event_at_ms"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("scores_project_time_idx").on(t.projectId, t.eventAtMs),
    uniqueIndex("scores_project_id_id_idx").on(t.projectId, t.id),
    foreignKey({
      columns: [t.projectId, t.traceId],
      foreignColumns: [traces.projectId, traces.id],
      name: "scores_project_trace_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.evalResultId],
      foreignColumns: [evalResults.projectId, evalResults.id],
      name: "scores_project_result_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.evaluatorId],
      foreignColumns: [evaluators.projectId, evaluators.id],
      name: "scores_project_evaluator_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.importId],
      foreignColumns: [scoreImports.projectId, scoreImports.id],
      name: "scores_project_import_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.traceId, t.spanId],
      foreignColumns: [spans.projectId, spans.traceId, spans.id],
      name: "scores_project_span_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
      name: "scores_project_session_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.evalRunId],
      foreignColumns: [evalRuns.projectId, evalRuns.id],
      name: "scores_project_run_fk",
    }).onDelete("cascade"),
    uniqueIndex("scores_project_import_idx").on(t.projectId, t.importId),
    check(
      "scores_origin_check",
      sql`(${t.external} is null and ${t.importId} is null and ${t.traceId} is not null and ${t.evalResultId} is not null and ${t.evaluatorId} is not null and ${t.spanId} is null and ${t.sessionId} is null and ${t.evalRunId} is null) or (${t.external} is not null and ${t.importId} is not null and ${t.evalResultId} is null and ${t.evaluatorId} is null and num_nonnulls(${t.traceId},${t.sessionId},${t.evalRunId})=1 and (${t.spanId} is null or ${t.traceId} is not null))`
    ),
    uniqueIndex("scores_project_result_idx").on(t.projectId, t.evalResultId),
  ]
)

export const customViews = pgTable(
  "custom_views",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    resource: text("resource").notNull(),
    settingsJson: text("settings_json").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("custom_views_resource_idx").on(table.resource)]
)

export const savedViews = pgTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    resource: text("resource").notNull(),
    columnsJson: text("columns_json").notNull(),
    filtersJson: text("filters_json").notNull().default("[]"),
    sortJson: text("sort_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("saved_views_project_id_id_idx").on(t.projectId, t.id),
    index("saved_views_project_resource_idx").on(t.projectId, t.resource),
  ]
)

export const managedPrompts = pgTable("managed_prompts", {
  id: text("id").primaryKey(),
  ...projectScope(),
  slug: text("slug").notNull(),
  configJson: text("config_json").notNull(),
  revision: integer("revision").notNull(),
  publishedVersion: integer("published_version"),
  publishedConfigJson: text("published_config_json"),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("managed_prompts_slug_idx").on(table.projectId, table.slug)])

export const managedPromptVersions = pgTable("managed_prompt_versions", {
  id: text("id").primaryKey(),
  ...projectScope(),
  promptId: text("prompt_id").notNull(),
  revision: integer("revision").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("managed_prompt_versions_revision_idx").on(table.projectId, table.promptId, table.revision)])

export const scorers = pgTable(
  "scorers",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    slug: text("slug").notNull(),
    configJson: text("config_json").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("scorers_slug_idx").on(table.projectId, table.slug)]
)

export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  ...projectScope(),
  number: integer("number").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  templateId: text("template_id").notNull(),
  widgetCount: integer("widget_count").notNull(),
  configJson: text("config_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  presentationJson: text("presentation_json"),
  layout: text("layout").notNull().default("canvas"),
  presentationRevision: integer("presentation_revision").notNull().default(0),
  creationKey: text("creation_key").notNull(),
  inputHash: text("input_hash").notNull(),
  createdAt: text("created_at").notNull(),
  frozenAt: text("frozen_at").notNull(),
  status: text("status").$type<"draft" | "published">().notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at"),
  publishedAt: text("published_at"),
  publicToken: text("public_token"),
  inputJson: text("input_json"),
  author: jsonb("author").$type<import("@/src/lib/tracer/reports").ReportAuthor>(),
    mdxJson: text("mdx_json"),
}, (t) => [
  uniqueIndex("reports_project_id_number_key").on(t.projectId, t.number),
  uniqueIndex("reports_project_id_creation_key_key").on(t.projectId, t.creationKey),
  index("reports_project_created_idx").on(t.projectId, t.createdAt, t.id),
])

export const dashboards = pgTable("dashboards", {
  id: text("id").primaryKey(),
  ...projectScope(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const customFields = pgTable(
  "custom_fields",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    definitionJson: text("definition_json").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("custom_fields_project_name_idx").on(
      table.projectId,
      table.nameKey
    ),
  ]
)

export const humanScores = pgTable("human_scores", {
  id: text("id").primaryKey(), ...projectScope(), name: text("name").notNull(),
  configJson: jsonDocument("config_json").notNull(), revision: integer("revision").notNull().default(1),
  archived: boolean("archived").notNull().default(false), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("human_scores_project_id_id_key").on(t.projectId,t.id), uniqueIndex("human_scores_name_idx").on(t.projectId,sql`lower(${t.name})`),check("human_scores_revision_check",sql`${t.revision} > 0`)])
export const humanScoreCollections = pgTable("human_score_collections", {
  id: text("id").primaryKey(), ...projectScope(), name: text("name").notNull(), description: text("description").notNull().default(""),
  revision: integer("revision").notNull().default(1), archived: boolean("archived").notNull().default(false),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("human_score_collections_project_id_id_key").on(t.projectId,t.id), uniqueIndex("human_score_collections_name_idx").on(t.projectId,sql`lower(${t.name})`),check("human_score_collections_revision_check",sql`${t.revision} > 0`)])
export const humanScoreCollectionItems = pgTable("human_score_collection_items", {
  ...projectScope(), collectionId: text("collection_id").notNull(), humanScoreId: text("human_score_id").notNull(), ordinal: integer("ordinal").notNull(),
}, t => [uniqueIndex("human_score_collection_items_pkey").on(t.projectId,t.collectionId,t.humanScoreId),uniqueIndex("human_score_collection_items_project_id_collection_id_ordinal_key").on(t.projectId,t.collectionId,t.ordinal),
  foreignKey({columns:[t.projectId,t.collectionId],foreignColumns:[humanScoreCollections.projectId,humanScoreCollections.id]}).onDelete("cascade"),
  foreignKey({columns:[t.projectId,t.humanScoreId],foreignColumns:[humanScores.projectId,humanScores.id]}).onDelete("cascade"),check("human_score_collection_items_ordinal_check",sql`${t.ordinal} >= 0`)])

const reviewUsers = pgTable("user", { id: text("id").primaryKey() })
export const reviewSessionCounters = pgTable("review_session_counters", {
  projectId: text("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  lastNumber: integer("last_number").notNull(),
}, (t) => [check("review_session_counters_last_number_check", sql`${t.lastNumber} > 0`)])
export const reviewSessions = pgTable(
  "review_sessions",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    // The BEFORE INSERT trigger replaces NULL with the next project number.
    number: integer("number").notNull().default(sql`null`),
    name: text("name").notNull().default("Untitled Review"),
    prompt: text("prompt").notNull().default(""),
    collectionId: text("collection_id"),
    collectionSnapshotJson: jsonDocument("collection_snapshot_json"),
    assigneeUserId: text("assignee_user_id").references(() => reviewUsers.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => reviewUsers.id, {
      onDelete: "set null",
    }),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    foreignKey({columns:[t.projectId,t.collectionId],foreignColumns:[humanScoreCollections.projectId,humanScoreCollections.id]}).onDelete("no action"),
    uniqueIndex("review_sessions_project_id_id_key").on(t.projectId, t.id),
    uniqueIndex("review_sessions_project_number_key").on(t.projectId, t.number),
    check("review_sessions_number_check", sql`${t.number} > 0`),
    index("review_sessions_project_page_idx").on(
      t.projectId,
      t.createdAt,
      t.id
    ),
    index("review_sessions_assignee_idx").on(t.projectId, t.assigneeUserId),
    check(
      "review_sessions_name_check",
      sql`length(btrim(${t.name})) between 1 and 200`
    ),
    check("review_sessions_revision_check", sql`${t.revision} > 0`),
  ]
)
export const reviewSessionReviewers = pgTable("review_session_reviewers", {
  ...projectScope(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull().references(() => reviewUsers.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
}, t => [
  uniqueIndex("review_session_reviewers_pkey").on(t.projectId, t.sessionId, t.userId),
  uniqueIndex("review_session_reviewers_project_id_session_id_ordinal_key").on(t.projectId, t.sessionId, t.ordinal),
  foreignKey({columns: [t.projectId, t.sessionId], foreignColumns: [reviewSessions.projectId, reviewSessions.id]}).onDelete("cascade"),
  index("review_session_reviewers_user_idx").on(t.userId),
  check("review_session_reviewers_ordinal_check", sql`${t.ordinal} >= 0`),
])
export const reviewItems = pgTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    sessionId: text("session_id").notNull(),
    traceId: text("trace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    notes: text("notes").notNull().default(""),
    annotationsJson: jsonDocument("annotations_json").notNull().default("[]"),
    notesProvenanceJson: jsonDocument("notes_provenance_json"),
    lastSubmissionJson: jsonDocument("last_submission_json"),
    revision: integer("revision").notNull().default(0),
    reviewedAt: text("reviewed_at"),
    skippedAt: text("skipped_at"),
    reviewedBy: text("reviewed_by").references(() => reviewUsers.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("review_items_project_id_id_key").on(t.projectId, t.id),
    uniqueIndex("review_items_project_id_id_trace_id_key").on(
      t.projectId,
      t.id,
      t.traceId
    ),
    uniqueIndex("review_items_project_id_session_id_trace_id_key").on(
      t.projectId,
      t.sessionId,
      t.traceId
    ),
    uniqueIndex("review_items_project_id_session_id_ordinal_key").on(
      t.projectId,
      t.sessionId,
      t.ordinal
    ),
    index("review_items_trace_idx").on(t.projectId, t.traceId),
    foreignKey({
      columns: [t.projectId, t.sessionId],
      foreignColumns: [reviewSessions.projectId, reviewSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.traceId],
      foreignColumns: [traces.projectId, traces.id],
    }).onDelete("no action"),
    check("review_items_ordinal_check", sql`${t.ordinal} >= 0`),
    check("review_items_notes_check", sql`length(${t.notes}) <= 16000`),
    check("review_items_annotations_json_check", sql`jsonb_typeof(${t.annotationsJson}) = 'array' AND jsonb_array_length(${t.annotationsJson}) <= 100`),
    check("review_items_revision_check", sql`${t.revision} >= 0`),
  ]
)
export const reviewScores = pgTable(
  "review_scores",
  {
    id: text("id").primaryKey(),
    ...projectScope(),
    itemId: text("item_id").notNull(),
    traceId: text("trace_id").notNull(),
    criterionKey: text("criterion_key").notNull(),
    scorerId: text("scorer_id"),
    scorerRevision: integer("scorer_revision"),
    name: text("name").notNull(),
    value: doublePrecision("value"),
    humanScoreId: text("human_score_id").notNull(),
    definitionJson: jsonDocument("definition_json").notNull(),
    humanValue: jsonDocument("human_value").notNull(),
    comment: text("comment").notNull().default(""),
    reviewerId: text("reviewer_id").references(() => reviewUsers.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    provenanceJson: jsonDocument("provenance_json"),
    editedByJson: jsonDocument("edited_by_json"),
    eventAtMs: doublePrecision("event_at_ms"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    foreignKey({columns:[t.projectId,t.humanScoreId],foreignColumns:[humanScores.projectId,humanScores.id]}).onDelete("no action"),
    index("review_scores_project_time_idx").on(t.projectId, t.eventAtMs),
    uniqueIndex("review_scores_project_id_item_id_criterion_key_key").on(
      t.projectId,
      t.itemId,
      t.criterionKey
    ),
    index("review_scores_trace_page_idx").on(
      t.projectId,
      t.traceId,
      t.updatedAt,
      t.id
    ),
    foreignKey({
      columns: [t.projectId, t.itemId, t.traceId],
      foreignColumns: [
        reviewItems.projectId,
        reviewItems.id,
        reviewItems.traceId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.scorerId],
      foreignColumns: [evaluators.projectId, evaluators.id],
    }).onDelete("no action"),
    check(
      "review_scores_name_check",
      sql`length(btrim(${t.name})) between 1 and 120`
    ),
    check(
      "review_scores_value_check",
      sql`${t.value} >= 0 and ${t.value} <= 1`
    ),
    check("review_scores_source_check", sql`${t.source} in ('human','mcp','api')`),
  ]
)

export const reactViews = pgTable("react_views", {
  objectTypes: jsonb("object_types").$type<("trace" | "dataset-item")[]>().notNull().default(["trace", "dataset-item"]),
  inputContract: text("input_contract").$type<"legacy-trace" | "object">().notNull().default("legacy-trace"),
  customFields: jsonb("custom_fields").$type<{ id: string; revision?: number }[]>().notNull().default([]),
  dataMode: text("data_mode").$type<"full" | "summary">().notNull().default("full"),
  id: text("id").primaryKey(),
  ...projectScope(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  code: text("code").notNull(),
  requirements: jsonb("requirements").$type<import("@/src/lib/tracer/react-views").ViewRequirement[] | null>(),
  origin: jsonb("origin").$type<import("@/src/lib/tracer/react-views").ReactViewOrigin | null>(),
  author: jsonb("author").$type<import("@/src/lib/tracer/react-views").ReactView["author"]>().notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, table => [index("react_views_project_page_idx").on(table.projectId, table.id)])

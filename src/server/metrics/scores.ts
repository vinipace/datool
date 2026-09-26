import {
  defineSemanticModel,
  type SemanticModel,
} from "@/src/lib/semantic/model"
import {
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  METRIC_MODEL_VERSION,
  idFilterOperators,
  labelFilterOperators,
  quality,
} from "./common"
import { executeScoresSql } from "./scores-sql"

export const SCORES_SEMANTIC_MODEL_NAME = "scores" as const
export const SCORES_COMPLETED_AT = "scores.completedAt" as const
export const SCORES_STATUS = "scores.status" as const
export const SCORES_EVAL_RUN_ID = "scores.evalRunId" as const
export const SCORES_EVAL_RUN_NAME = "scores.evalRunName" as const
export const SCORES_EVALUATOR_ID = "scores.evaluatorId" as const
export const SCORES_EVALUATOR_VERSION_ID = "scores.evaluatorVersionId" as const
export const SCORES_EVALUATOR_VERSION = "scores.evaluatorVersion" as const
export const SCORES_EVALUATOR_NAME = "scores.evaluatorName" as const
export const SCORES_DATASET_ID = "scores.datasetId" as const
export const SCORES_TRACE_ID = "scores.traceId" as const
const SCORE_LIMITATIONS = [
  "Scores use one persisted eval_results row per evaluation execution plus its optional unique scores row named score. Arbitrary evaluator metadata is not treated as score facts.",
  "A scored value requires scores.status = ok and a finite persisted value from 0 through 1; zero is a valid score. Mean score uses that same set.",
  "Explicit pass rate divides passed = true by result rows whose passed value is explicitly true or false. It never derives a pass from a score threshold.",
  "Result status failed means an explicit evaluator check failed; result status error is a technical evaluator error.",
  "Event time is persisted eval_results.completedAt, falling back to createdAt only when completedAt is absent. It is not evaluator latency.",
  "Dataset ID is resolved through eval_results.datasetItemId to dataset_items.datasetId, not eval_runs.datasetId, because one run may contain mixed targets.",
  "Evaluator ID and evaluator version ID/version are historical execution identity. Evaluator name is a current mutable label and can change after execution.",
  "No result-to-target foreign key exists, so this model does not report exact selected-target coverage.",
  "Agent/workflow attribution uses current explicit memberships on the evaluated trace and its spans, not evaluator identity or a frozen execution snapshot. Each execution counts once per selected group; repeated invocations do not multiply it. Groups can overlap, so their counts must not be added to obtain global totals.",
] as const
const scoreMeasures = [
  {
    aggregation: "count",
    basis: "eval_results_execution",
    definition: "Count of persisted eval_results.id execution rows.",
    description: "Evaluator executions in the requested event-time window.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.executionCount",
    title: "Evaluator executions",
    type: "number",
    unit: "executions",
  },
  {
    aggregation: "count",
    basis: "valid_scores_by_eval_result",
    definition:
      "Count of eval_results with a unique scores companion whose status is ok and finite value is in the inclusive range 0 through 1.",
    description: "Valid numeric scores; zero is included.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.scoredCount",
    title: "Scored executions",
    type: "number",
    unit: "executions",
  },
  {
    aggregation: "average",
    basis: "valid_scores_by_eval_result",
    definition:
      "Arithmetic mean of the same valid score set used by scores.scoredCount.",
    description:
      "Mean score from zero through one; null when no valid score exists.",
    format: "ratio",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.meanScore",
    title: "Mean score",
    type: "number",
    unit: "fraction",
  },
  {
    aggregation: "count",
    basis: "explicit_passed_results",
    definition: "Count of eval_results rows with passed = true.",
    description: "Explicit evaluator pass outcomes.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.explicitPassCount",
    title: "Explicit passes",
    type: "number",
    unit: "results",
  },
  {
    aggregation: "count",
    basis: "explicit_passed_results",
    definition: "Count of eval_results rows with passed = false.",
    description: "Explicit evaluator fail outcomes.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.explicitFailCount",
    title: "Explicit fails",
    type: "number",
    unit: "results",
  },
  {
    aggregation: "ratio",
    basis: "explicit_passed_results",
    definition:
      "Count of passed = true divided by count of passed values that are true or false.",
    description:
      "Explicit pass rate; null when no binary pass/fail outcome exists.",
    format: "ratio",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.explicitPassRate",
    title: "Explicit pass rate",
    type: "number",
    unit: "fraction",
  },
  {
    aggregation: "count",
    basis: "eval_results_execution",
    definition: "Count of eval_results rows with status error.",
    description:
      "Technical evaluator errors, distinct from explicit failed checks.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.errorCount",
    title: "Evaluator errors",
    type: "number",
    unit: "results",
  },
  {
    aggregation: "count",
    basis: "eval_results_execution",
    definition: "Count of eval_results rows with status failed.",
    description:
      "Explicit evaluator checks that failed, not technical evaluator errors.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.failedCheckCount",
    title: "Failed checks",
    type: "number",
    unit: "results",
  },
  {
    aggregation: "countDistinct",
    basis: "eval_results_execution",
    definition:
      "Distinct eval_results.traceId values among execution facts in each result group.",
    description: "Unique traces that received an evaluator execution.",
    format: "integer",
    kind: "measure",
    limitations: SCORE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "scores.uniqueTraceCount",
    title: "Unique evaluated traces",
    type: "number",
    unit: "traces",
  },
] as const

export const scoresSemanticModel = defineSemanticModel({
  defaultMeasures: [
    "scores.meanScore",
    "scores.explicitPassRate",
    "scores.executionCount",
  ],
  defaultOrder: [
    [SCORES_COMPLETED_AT, "asc"],
    [SCORES_EVALUATOR_ID, "asc"],
    [SCORES_STATUS, "asc"],
  ],
  execute: async (query, context) => {
    const { warnings, ...page } = await executeScoresSql(query, context)
    return { ...page, quality: quality(SCORE_LIMITATIONS, warnings) }
  },
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...scoreMeasures,
    ...(
      [
        [
          "groupType",
          "Operation type",
          "Explicit membership type: agent or workflow.",
        ],
        [
          "groupName",
          "Operation",
          "Explicit agent or workflow name on the evaluated trace or one of its spans.",
        ],
        [
          "groupVersion",
          "Operation version",
          "Recorded membership version; absent versions remain null.",
        ],
      ] as const
    ).map(([member, title, description]) => ({
      name: `scores.${member}`,
      title,
      description,
      definition:
        "Distinct trace_group_memberships values linked by project and eval_results.traceId. Executions are deduplicated within each selected grouping after filters; missing memberships remain null.",
      kind: "dimension" as const,
      type: "string" as const,
      groupable: true,
      filterOperators: labelFilterOperators,
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
    })),
    {
      definition:
        "eval_results.completedAt when present, otherwise eval_results.createdAt.",
      description:
        "Persisted evaluator result event time used for calendar bucketing; it is not evaluator latency.",
      granularities: ["day"],
      kind: "timeDimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_COMPLETED_AT,
      title: "Completed at",
      type: "date",
    },
    {
      definition: "The persisted eval_results.status value.",
      description:
        "Result status; failed is an explicit check failure and error is a technical evaluator failure.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_STATUS,
      title: "Result status",
      type: "string",
    },
    {
      definition: "The persisted eval_results.runId foreign key.",
      description: "Historical eval-run identifier for result comparison.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVAL_RUN_ID,
      title: "Eval run ID",
      type: "string",
    },
    {
      definition:
        "The current eval_runs.name label joined by eval_results.runId.",
      description: "Eval-run display label when present.",
      filterOperators: labelFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVAL_RUN_NAME,
      title: "Eval run name",
      type: "string",
    },
    {
      definition: "The persisted eval_results.evaluatorId foreign key.",
      description: "Historical evaluator identifier for result comparison.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVALUATOR_ID,
      title: "Evaluator ID",
      type: "string",
    },
    {
      definition: "The persisted eval_results.evaluatorVersionId foreign key.",
      description:
        "Historical evaluator version identifier attached to this execution.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVALUATOR_VERSION_ID,
      title: "Evaluator version ID",
      type: "string",
    },
    {
      definition:
        "The evaluator_versions.version value joined through eval_results.evaluatorVersionId.",
      description: "Historical evaluator version number for this execution.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVALUATOR_VERSION,
      title: "Evaluator version",
      type: "number",
    },
    {
      definition:
        "The current evaluators.name label joined through eval_results.evaluatorId.",
      description:
        "Current evaluator display label; it can change after historical executions are recorded.",
      filterOperators: labelFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_EVALUATOR_NAME,
      title: "Evaluator name",
      type: "string",
    },
    {
      definition:
        "dataset_items.datasetId joined through eval_results.datasetItemId.",
      description:
        "Dataset ID at result grain; direct trace targets and unknown item links remain null.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_DATASET_ID,
      title: "Dataset ID",
      type: "string",
    },
    {
      definition: "The persisted eval_results.traceId foreign key.",
      description: "Trace ID for filtering evaluator execution facts.",
      filterOperators: idFilterOperators,
      groupable: false,
      kind: "dimension",
      limitations: SCORE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: SCORES_TRACE_ID,
      title: "Trace ID",
      type: "string",
    },
  ],
  name: SCORES_SEMANTIC_MODEL_NAME,
  version: METRIC_MODEL_VERSION,
} satisfies SemanticModel)

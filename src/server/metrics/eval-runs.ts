import {
  sourceDimension,
  sourceMeasures,
  metadataDimension,
} from "./source-contract"
import { invocationFilterMember } from "@/src/lib/semantic/group-filter"
import {
  defineSemanticModel,
  type SemanticModel,
} from "@/src/lib/semantic/model"
import {
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  METRIC_MODEL_VERSION,
  idFilterOperators,
  quality,
} from "./common"
import { executeEvalRunsSql } from "./eval-runs-sql"

export const EVAL_RUNS_SEMANTIC_MODEL_NAME = "evalRuns" as const
export const EVAL_RUNS_CREATED_AT = "evalRuns.createdAt" as const
export const EVAL_RUNS_STATUS = "evalRuns.status" as const
export const EVAL_RUNS_DATASET_ID = "evalRuns.datasetId" as const
const EVAL_RUN_LIMITATIONS = [
  "Eval-run metrics use one persisted eval_runs row per fact; they do not join target, evaluator, and result rows into a fanout.",
  "Result counts come from direct eval_results rows keyed by runId.",
  "Selected-target counts come only from durable eval_run_targets snapshots. Coverage excludes runs without sufficient frozen target/scorer linkage; use coverage-eligible run count to inspect its population.",
] as const
const evalRunMeasures = [
  {
    aggregation: "count",
    basis: "persisted_eval_runs",
    definition: "Count of persisted eval_runs.id rows.",
    description: "Eval runs created in the requested time window.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.count",
    title: "Eval runs",
    type: "number",
    unit: "runs",
  },
  {
    aggregation: "count",
    basis: "persisted_eval_runs",
    definition: "Count of eval_runs with status completed.",
    description: "Eval runs explicitly persisted as completed.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.completedCount",
    title: "Completed eval runs",
    type: "number",
    unit: "runs",
  },
  {
    aggregation: "count",
    basis: "persisted_eval_runs",
    definition: "Count of eval_runs with status failed.",
    description: "Eval runs whose persisted run status is failed.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.failedCount",
    title: "Failed eval runs",
    type: "number",
    unit: "runs",
  },
  {
    aggregation: "count",
    basis: "persisted_eval_runs",
    definition: "Count of eval_runs with status partial.",
    description:
      "Eval runs with a mix of completed and errored evaluator results.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.partialCount",
    title: "Partial eval runs",
    type: "number",
    unit: "runs",
  },
  {
    aggregation: "count",
    basis: "persisted_eval_runs",
    definition: "Count of eval_runs with status running.",
    description: "Eval runs that remain persisted as running.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.runningCount",
    title: "Running eval runs",
    type: "number",
    unit: "runs",
  },
  {
    aggregation: "count",
    basis: "eval_results_by_run",
    definition:
      "Count of direct persisted eval_results rows grouped by eval_results.runId.",
    description:
      "Executed evaluator result rows, without joining evaluator or target rows.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.resultCount",
    title: "Eval results",
    type: "number",
    unit: "results",
  },
  {
    aggregation: "count",
    basis: "eval_run_targets_snapshot",
    definition:
      "Count of durable eval_run_targets rows grouped by eval_run_targets.runId.",
    description: "Selected target records captured when an eval run started.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.selectedTargetCount",
    title: "Selected targets",
    type: "number",
    unit: "targets",
  },
  {
    aggregation: "countDistinct",
    basis: "eval_run_targets_snapshot",
    definition:
      "Count of distinct eval_run_targets.traceId values across every selected target in each final output group.",
    description:
      "Unique trace IDs across the durable selected-target snapshots represented by the output group.",
    format: "integer",
    kind: "measure",
    limitations: EVAL_RUN_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "evalRuns.selectedUniqueTraceCount",
    title: "Selected unique traces",
    type: "number",
    unit: "traces",
  },
] as const

export const evalRunsSemanticModel = defineSemanticModel({
  defaultMeasures: ["evalRuns.count"],
  defaultOrder: [
    [EVAL_RUNS_CREATED_AT, "asc"],
    [EVAL_RUNS_STATUS, "asc"],
    [EVAL_RUNS_DATASET_ID, "asc"],
  ],
  execute: async (query, context) => {
    const { warnings, ...page } = await executeEvalRunsSql(query, context)
    return { ...page, quality: quality(EVAL_RUN_LIMITATIONS, warnings) }
  },
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...sourceMeasures(
      "evalRuns",
      [
        [
          "cancelledCount",
          "Cancelled runs",
          "count",
          "runs",
          "Persisted cancelled evaluation batches.",
        ],
        [
          "durationSampleCount",
          "Elapsed duration samples",
          "count",
          "runs",
          "Terminal batches with valid creation-to-completion elapsed time.",
        ],
        [
          "meanDurationMs",
          "Average elapsed run duration",
          "average",
          "ms",
          "Mean creation-to-completion elapsed time, including queue and batch overhead.",
          "Terminal runs with valid elapsed time",
        ],
        [
          "p95DurationMs",
          "P95 elapsed run duration",
          "percentile",
          "ms",
          "Nearest-rank P95 elapsed run duration, including queue and batch overhead.",
        ],
        [
          "executedCaseCount",
          "Executed cases",
          "count",
          "cases",
          "Selected targets with at least one linked result, counted once per run and target, within coverage-eligible runs.",
        ],
        [
          "completedCaseCount",
          "Completed cases",
          "count",
          "cases",
          "Selected targets with terminal results for every frozen scorer/version. Technical errors are terminal; this is completion, not quality success.",
        ],
        [
          "coverageEligibleRunCount",
          "Coverage-eligible runs",
          "count",
          "runs",
          "Runs with selected targets, frozen scorers and no unlinked or mismatched scorer results.",
        ],
        [
          "executionCoverage",
          "Case execution coverage",
          "ratio",
          "ratio",
          "Executed cases divided by selected cases, only in coverage-eligible runs.",
          "Selected cases in coverage-eligible runs",
        ],
        [
          "completionCoverage",
          "Case completion coverage",
          "ratio",
          "ratio",
          "Fully completed cases divided by selected cases, only in coverage-eligible runs.",
          "Selected cases in coverage-eligible runs",
        ],
      ],
      "project + run",
      "Run creation"
    ),
    sourceDimension("evalRuns", "id", "Run ID", "Persisted run identity."),
    sourceDimension("evalRuns", "name", "Run name", "Recorded run name."),
    ...["agent", "workflow", "containsModel"].map((key) =>
      sourceDimension(
        "evalRuns",
        key,
        key === "containsModel"
          ? "Contains evaluated model"
          : key === "agent"
            ? "Agent"
            : "Workflow",
        "Runs with a matching saved case attribution. Counts remain at run grain.",
        { groupable: false }
      )
    ),
    invocationFilterMember("evalRuns", "v1"),
    metadataDimension(
      "evalRuns",
      "metadata",
      "Run metadata",
      "Typed paths in recorded run metadata."
    ),
    ...evalRunMeasures,
    {
      definition:
        "The persisted eval_runs.createdAt timestamp used for calendar bucketing.",
      description:
        "Eval-run creation instant used for the requested half-open time window.",
      granularities: ["day", "week", "month"],
      kind: "timeDimension",
      limitations: EVAL_RUN_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: EVAL_RUNS_CREATED_AT,
      title: "Created at",
      type: "date",
    },
    {
      definition: "The persisted eval_runs.status lifecycle value.",
      description: "Eval-run lifecycle status.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: EVAL_RUN_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: EVAL_RUNS_STATUS,
      title: "Status",
      type: "string",
    },
    {
      definition: "The persisted eval_runs.datasetId foreign key when present.",
      description: "Dataset selected for the eval run.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: EVAL_RUN_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: EVAL_RUNS_DATASET_ID,
      title: "Dataset ID",
      type: "string",
    },
  ],
  name: EVAL_RUNS_SEMANTIC_MODEL_NAME,
  version: METRIC_MODEL_VERSION,
} satisfies SemanticModel)

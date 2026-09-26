import { spansSemanticModel } from "./spans"
import { evalResultsSemanticModel } from "./eval-results"
import { scoreValuesSemanticModel } from "./score-values"
import type { SemanticSourcePresentation } from "@/src/lib/semantic/model"
import { logsSemanticModel } from "./logs"
import { evalQualitySemanticModel } from "./eval-quality"
import { createSemanticCatalog } from "@/src/lib/semantic/catalog"

import { evalRunsSemanticModel } from "@/src/server/metrics/eval-runs"
import { scoresSemanticModel } from "@/src/server/metrics/scores"
import {
  agentsSemanticModel,
  workflowsSemanticModel,
} from "@/src/server/metrics/performance"
import { tracesSemanticModel } from "@/src/server/metrics/traces"

/**
 * The single explicit registration point for Datool's persisted analytics.
 * Models are static server code; requests can select members but cannot add
 * executable or dynamically inferred metrics.
 */
const sourcePresentation: Record<string, SemanticSourcePresentation> = {
  traces: {
    title: "Traces",
    description:
      "Whole requests: failures, duration and total child LLM usage.",
    grain: "One request",
    visibility: "primary",
    order: 0,
  },
  spans: {
    title: "Spans",
    description:
      "Individual steps: LLM calls, tool calls, duration, tokens and cost.",
    grain: "One span",
    visibility: "primary",
    order: 1,
  },
  evalRuns: {
    title: "Evaluation Runs",
    description:
      "Evaluation batches: lifecycle, selected cases and execution coverage.",
    unavailable: [
      {
        title: "Run cost",
        reason:
          "Workload and scorer cost require separately linked execution telemetry.",
      },
    ],
    grain: "One evaluation batch",
    visibility: "primary",
    order: 2,
  },
  evalResults: {
    title: "Evaluation Results",
    description:
      "Scorer executions: quality outcomes, errors and saved case context.",
    unavailable: [
      {
        title: "Scorer duration, cost and model",
        reason:
          "Result timestamps and workload telemetry cannot establish measured scorer execution telemetry.",
      },
      {
        title: "Saved user, session and provider",
        reason:
          "These fields are not recorded in the saved attribution contract for every case.",
      },
    ],
    grain: "One scorer execution against a case",
    visibility: "primary",
    order: 3,
  },
  scoreValues: {
    title: "Scores",
    description:
      "Saved ratings from scorers, imports and reviews, with explicit types and scales.",
    unavailable: [
      {
        title: "History of review edits",
        reason:
          "Review ratings store their current state. An append-only event log is required for edit history.",
      },
      {
        title: "Evaluated operation and model",
        reason:
          "Rating origins have different optional target links. Use Evaluation Results for saved evaluation-time attribution.",
      },
    ],
    grain: "One current saved rating",
    visibility: "primary",
    order: 4,
  },
  logs: {
    title: "Spans & LLM usage (legacy)",
    description: "Original mixed span usage and request latency definitions.",
    grain: "Legacy metric-specific population",
    visibility: "legacy",
    replacement: "spans",
  },
  scores: {
    title: "Scorer results (legacy)",
    description:
      "Original evaluation executions with current trace memberships.",
    grain: "One scorer execution",
    visibility: "legacy",
    replacement: "evalResults",
  },
  evalQuality: {
    title: "Evaluation quality (legacy)",
    description: "Only results with saved attribution.",
    grain: "One attributed scorer execution",
    visibility: "legacy",
    replacement: "evalResults",
  },
  agents: {
    title: "Agents (legacy)",
    description: "Recorded agent invocations and inclusive costs.",
    grain: "One agent invocation",
    visibility: "legacy",
  },
  workflows: {
    title: "Workflows (legacy)",
    description: "Recorded workflow invocations and inclusive costs.",
    grain: "One workflow invocation",
    visibility: "legacy",
  },
}

export const metricModels = Object.freeze(
  [
    spansSemanticModel,
    evalResultsSemanticModel,
    scoreValuesSemanticModel,
    tracesSemanticModel,
    logsSemanticModel,
    agentsSemanticModel,
    workflowsSemanticModel,
    evalRunsSemanticModel,
    scoresSemanticModel,
    evalQualitySemanticModel,
  ].map((model) => ({ ...model, source: sourcePresentation[model.name] }))
)

export const semanticCatalog = createSemanticCatalog(metricModels)

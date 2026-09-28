import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type { DashboardInput, DashboardWidget } from "./dashboards"
import { dashboardTemplates } from "./dashboard-templates"

function evaluationComparison(now = new Date()): DashboardInput {
  const range = [
    new Date(now.getTime() - 7 * 86400000).toISOString(),
    now.toISOString(),
  ]
  const widget = (
    id: string,
    title: string,
    measures: string[],
    dimensions: string[],
    type: DashboardWidget["type"] = "table"
  ): DashboardWidget => ({
    id,
    title,
    type,
    width: type === "matrix" ? 3 : 2,
    query: semanticQuerySchema.parse({
      measures: measures.map((key) => `evalResults.${key}`),
      dimensions: dimensions.map((key) => `evalResults.${key}`),
      timeDimensions: [
        {
          dimension: "evalResults.completedAt",
          dateRange: range,
          ...(type === "line" ? { granularity: "day" } : {}),
        },
      ],
      limit: type === "line" ? 5000 : 20,
      total: true,
    }),
  })
  return {
    schemaVersion: 1,
    name: "Evaluation comparison",
    description:
      "Compare recorded prompt versions, datasets and scorers. Missing prompt provenance stays unknown.",
    widgets: [
      { id: "summary", title: "Summary", type: "text", width: 3, content: "" },
      widget(
        "dataset-scores",
        "Prompt version × dataset",
        ["meanScore"],
        [
          "groupName",
          "promptId",
          "promptVersion",
          "evaluatorName",
          "evaluatorVersion",
          "datasetId",
        ],
        "matrix"
      ),
      widget(
        "scorer-scores",
        "Prompt version × scorer",
        ["meanScore"],
        [
          "groupName",
          "promptId",
          "promptVersion",
          "evaluatorVersion",
          "evaluatorName",
        ],
        "matrix"
      ),
      widget(
        "score-distribution",
        "Score distribution and samples",
        ["meanScore", "p50Score", "p95Score", "scoredCount", "errorCount"],
        ["groupName", "promptVersion", "evaluatorName", "evaluatorVersion"]
      ),
      widget(
        "quality-progress",
        "Check pass rate over time",
        ["explicitPassRate"],
        ["groupName"],
        "line"
      ),
      widget(
        "case-coverage",
        "Evaluation coverage",
        ["uniqueCaseCount", "executionCount", "unattributedCount"],
        ["groupName", "evalRunName"]
      ),
    ],
  }
}

/** Reports reuse the dashboard widget contract; templates contain no saved facts. */
export const reportTemplates = [
  {
    id: "evaluation-comparison",
    name: "Evaluation comparison",
    description:
      "Prompt-version matrices, score distributions and evaluation progress.",
    create: evaluationComparison,
  },
  ...dashboardTemplates.filter((template) =>
    ["evals", "cost-and-usage", "latency"].includes(template.id)
  ),
]

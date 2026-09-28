import type { SemanticCatalogModelMetadata } from "@/src/lib/semantic/catalog"
import {
  ChartBar,
  ChartScatter,
  ChartColumnStacked,
  ChartLine,
  ChartPie,
  Hash,
  Table2,
  Grid2X2,
  Type,
} from "lucide-react"

export const dashboardWidgetOptions = [
  { value: "text", label: "Text", icon: Type },
  { value: "scatter", label: "Scatter plot", icon: ChartScatter },
  { value: "matrix", label: "Matrix", icon: Grid2X2 },
  { value: "metric", label: "Metric tile", icon: Hash },
  { value: "line", label: "Line chart", icon: ChartLine },
  { value: "stacked", label: "Stacked time chart", icon: ChartColumnStacked },
  { value: "bar", label: "Bar chart", icon: ChartBar },
  { value: "donut", label: "Donut chart", icon: ChartPie },
  { value: "table", label: "Table", icon: Table2 },
] as const

const dataSources: Record<string, { label: string; description: string }> = {
  traces: {
    label: "Traces",
    description:
      "Whole requests: volume, failures and end-to-end latency. Each trace counts once.",
  },
  logs: {
    label: "Spans & LLM usage",
    description:
      "Steps within requests: LLM calls, tool calls, tokens and LLM cost. Use for cost by model.",
  },
  agents: {
    label: "Agents",
    description:
      "Recorded agent operations: volume, failures, latency and inclusive cost by name or version.",
  },
  workflows: {
    label: "Workflows",
    description:
      "Recorded workflow operations: volume, failures, latency and inclusive cost by name or version.",
  },
  evalRuns: {
    label: "Evaluation runs",
    description:
      "Evaluation batches: running, completed or failed runs, selected targets and result counts.",
  },
  scores: {
    label: "Scorer results",
    description:
      "Individual scorer executions: scores, explicit pass/fail outcomes and scorer errors.",
  },
  evalQuality: {
    label: "Evaluation quality",
    description:
      "Compare scores by saved agent, workflow, version or evaluated model. Requires saved case attribution.",
  },
}

export function dashboardDataSourceOption(
  name: string,
  model?: SemanticCatalogModelMetadata
) {
  const source = model?.source
    ? { label: model.source.title, description: model.source.description }
    : (dataSources[name] ?? { label: name, description: "" })
  return {
    value: name,
    ...source,
    descriptionBelow: true,
    descriptionWrap: true,
    keywords: [name, source.description],
  }
}

export function dashboardSourceOptions(
  models: readonly SemanticCatalogModelMetadata[],
  selected: string
) {
  return models
    .filter(
      (model) =>
        (model.source?.visibility === "primary" && !["evalClassification", "evalComparison"].includes(model.name)) ||
        model.name === selected ||
        !model.source
    )
    .sort((a, b) => (a.source?.order ?? 99) - (b.source?.order ?? 99))
    .map((model) => dashboardDataSourceOption(model.name, model))
}

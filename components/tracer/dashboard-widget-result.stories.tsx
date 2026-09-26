import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { SemanticResult } from "@/src/lib/semantic/result"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import { previousPeriodQuery } from "@/src/lib/tracer/dashboard-metric-comparison"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  barResult,
  barWidget,
  emptyMetricResult,
  lineResult,
  lineSummary,
  lineWidget,
  metricResult,
  metricWidget,
  semanticResultForQuery,
  tableResult,
  tableWidget,
} from "../../.storybook/scenarios/dashboards/fixtures"
import { WidgetResult } from "./dashboard-widget-result"

function ResultScenario({
  widget,
  result,
  summary,
  previous,
  history,
}: {
  widget: DashboardWidget
  result: SemanticResult
  summary: SemanticResult | null
  previous?: SemanticResult | null
  history?: SemanticResult | null
}) {
  const [requestedOffset, setRequestedOffset] = useState<number | null>(null)

  return (
    <StorybookProjectFrame title="Widget result">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <WidgetResult
          widget={widget}
          result={result}
          summary={summary}
          previous={previous}
          history={history}
          setOffset={setRequestedOffset}
        />
        <output className="sr-only">
          Requested offset: {requestedOffset ?? "none"}
        </output>
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/WidgetResult",
  component: ResultScenario,
  args: {
    widget: metricWidget,
    result: metricResult,
    summary: null,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/dashboards/result` },
    },
  },
} satisfies Meta<typeof ResultScenario>

export default meta
type Story = StoryObj<typeof meta>

export const Metric: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("128")).resolves.toBeVisible()
    await expect(canvas.queryByText("Traces")).not.toBeInTheDocument()
  },
}

export const Bar: Story = {
  args: { widget: barWidget, result: barResult, summary: null },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("group", {
        name: "Operations bar chart",
      })
    ).resolves.toBeVisible()
  },
}

const groupedWidget: DashboardWidget = {
  ...barWidget,
  title: "Cost by workflow and call",
  showGroupIcons: true,
  query: {
    ...barWidget.query,
    measures: ["logs.costUsd"],
    dimensions: ["logs.workflowName", "logs.functionName"],
    timeDimensions: barWidget.query.timeDimensions.map((time) => ({
      ...time,
      dimension: "logs.startedAt",
    })),
    order: [],
  },
}
const groupedResult = semanticResultForQuery(groupedWidget.query)
groupedResult.data = [
  {
    "logs.workflowName": "Support",
    "logs.functionName": "Answer",
    "logs.costUsd": 2,
  },
  {
    "logs.workflowName": "Support",
    "logs.functionName": "Extract",
    "logs.costUsd": 1,
  },
  {
    "logs.workflowName": "Support",
    "logs.functionName": null,
    "logs.costUsd": 0,
  },
]
groupedResult.meta.page.total = 3

export const MultipleGroupBar: Story = {
  args: { widget: groupedWidget, result: groupedResult },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const label of [
      "Support · Answer",
      "Support · Extract",
      "Support · Unattributed",
    ]) {
      await expect(canvas.getAllByTitle(label)[0]).toBeVisible()
    }
    // A multi-field bar must not link to traces scoped only by its first field.
    await expect(
      canvas.queryByRole("link", { name: /Support/ })
    ).not.toBeInTheDocument()
  },
}

export const MultipleGroupDonut: Story = {
  args: { widget: { ...groupedWidget, type: "donut" }, result: groupedResult },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const chart = await canvas.findByRole("group", {
      name: "Cost by workflow and call donut chart",
    })
    await waitFor(() =>
      expect(chart.querySelectorAll(".recharts-pie-sector")).toHaveLength(2)
    )
    for (const [index, label] of [
      "Support · Answer",
      "Support · Extract",
    ].entries()) {
      await userEvent.hover(
        chart.querySelectorAll(".recharts-pie-sector")[index]!
      )
      await expect(within(chart).findByTitle(label)).resolves.toBeVisible()
    }
    await expect(
      canvas.getAllByTitle("Support · Unattributed")[0]
    ).toBeVisible()
  },
}

const donutWidget: DashboardWidget = { ...barWidget, type: "donut" }
function donutResult(values: (number | null)[], total = values.length) {
  const result = semanticResultForQuery(donutWidget.query)
  result.data = values.map((value, index) => ({
    [result.query.dimensions[0]]: `Category ${index + 1}`,
    [result.query.measures[0]]: value,
  }))
  result.meta.page.total = total
  return result
}

export const Donut: Story = {
  args: { widget: donutWidget, result: donutResult([23, 19, 13]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const chart = await canvas.findByRole("group", {
      name: "Operations donut chart",
    })
    await waitFor(() =>
      expect(chart.querySelectorAll(".recharts-pie-sector")).toHaveLength(3)
    )
    await expect(canvas.getByText("55")).toBeVisible()
    await expect(canvas.queryByText(/Shares reflect/)).not.toBeInTheDocument()
    await userEvent.hover(chart.querySelector(".recharts-pie-sector")!)
    await expect(within(chart).findByText("Category 1")).resolves.toBeVisible()
    await expect(within(chart).getByText("23")).toBeVisible()
    await userEvent.hover(chart.querySelectorAll(".recharts-pie-sector")[1]!)
    await expect(within(chart).findByText("Category 2")).resolves.toBeVisible()
    await expect(within(chart).getByText("19")).toBeVisible()
  },
}

export const DonutPage: Story = {
  args: { widget: donutWidget, result: donutResult([23, 19], 4) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Shown total")).toBeVisible()
    await expect(
      canvas.getByText(/Shares reflect only the categories on this page/)
    ).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled()
  },
}

export const DonutNoPositiveValues: Story = {
  args: { widget: donutWidget, result: donutResult([0, null]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("No positive values in this time range.")
    ).toBeVisible()
    await expect(
      canvas.queryByRole("group", { name: /donut chart/ })
    ).not.toBeInTheDocument()
    await expect(canvas.getByText("0", { exact: true })).toBeVisible()
    await expect(
      canvas.getByText(/Categories with no data are omitted/)
    ).toBeVisible()
  },
}

export const DonutNegativeValues: Story = {
  args: { widget: donutWidget, result: donutResult([23, -5]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText(/Negative values cannot be shown/)
    ).toBeVisible()
    await expect(
      canvas.queryByRole("group", { name: /donut chart/ })
    ).not.toBeInTheDocument()
  },
}

export const TimeSeries: Story = {
  args: { widget: lineWidget, result: lineResult, summary: lineSummary },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("group", { name: "Latency chart" })
    ).resolves.toBeVisible()
  },
}

export const MissingTimeValues: Story = {
  args: {
    widget: lineWidget,
    result: {
      ...lineResult,
      data: lineResult.data.map((row, index) => ({
        ...row,
        ...Object.fromEntries(
          lineResult.query.measures.map((measure) => [
            measure,
            index === 2 ? null : row[measure],
          ])
        ),
      })),
    },
    summary: lineSummary,
  },
  play: async ({ canvasElement }) => {
    const chart = await within(canvasElement).findByRole("group", {
      name: "Latency chart",
    })
    await waitFor(() =>
      expect(
        chart.querySelectorAll("path.recharts-line-curve[stroke-dasharray]")
      ).toHaveLength(lineWidget.query.measures.length)
    )
    const application = within(chart).getByRole("application")
    application.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    await expect(within(chart).findByText("2026-09-10")).resolves.toBeVisible()
    await expect(within(chart).queryByText("No data")).not.toBeInTheDocument()
    await expect(
      chart.querySelectorAll(".recharts-active-dot circle")
    ).toHaveLength(0)
  },
}

export const OmittedTimeBucket: Story = {
  args: {
    widget: lineWidget,
    result: {
      ...lineResult,
      data: lineResult.data.slice(0, 2),
      meta: { ...lineResult.meta, page: { ...lineResult.meta.page, total: 2 } },
    },
    summary: lineSummary,
  },
  play: async ({ canvasElement }) => {
    const chart = await within(canvasElement).findByRole("group", {
      name: "Latency chart",
    })
    await waitFor(() =>
      expect(
        chart.querySelectorAll("path.recharts-line-curve[stroke-dasharray]")
      ).toHaveLength(lineWidget.query.measures.length)
    )
    within(chart).getByRole("application").focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    await expect(within(chart).findByText("2026-09-10")).resolves.toBeVisible()
    await expect(within(chart).queryByText("No data")).not.toBeInTheDocument()
  },
}

export const FilteredTimeSeries: Story = {
  args: {
    widget: {
      ...lineWidget,
      query: {
        ...lineWidget.query,
        having: [
          { member: "logs.p95LatencyMs", operator: "gt", values: [1000] },
        ],
      },
    },
    result: lineResult,
    summary: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("group", { name: "Latency chart" })
    ).resolves.toBeVisible()
    await expect(canvas.getByText("P95 latency")).toBeVisible()
    await expect(canvas.queryByRole("table")).not.toBeInTheDocument()
  },
}

export const TablePagination: Story = {
  args: { widget: tableWidget, result: tableResult, summary: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("1–2 of 4")).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await expect(
      canvas.findByText("Requested offset: 2")
    ).resolves.toBeVisible()
  },
}

const percentageTableWidget: DashboardWidget = {
  ...tableWidget,
  query: {
    ...tableWidget.query,
    measures: ["traces.errorRate", "traces.count"],
    limit: 10,
    offset: 0,
  },
}
const percentageTableResult = semanticResultForQuery(
  percentageTableWidget.query
)
percentageTableResult.data = [0, 0.8, 1, null].map((value, index) => ({
  [percentageTableWidget.query.dimensions[0]]: `Request ${index + 1}`,
  "traces.errorRate": value,
  "traces.count": index + 10,
}))
percentageTableResult.meta.page.total = 4

export const TablePercentages: Story = {
  args: {
    widget: percentageTableWidget,
    result: percentageTableResult,
    summary: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const percentage of ["0%", "80%", "100%"]) {
      const cell = await canvas.findByRole("cell", {
        name: percentage,
      })
      const fill = cell.querySelector(".bg-destructive")!
      const track = cell.querySelector(".bg-score-track")!
      await expect(fill.getBoundingClientRect().width).toBeCloseTo(
        (track.getBoundingClientRect().width * parseFloat(percentage)) / 100,
        1
      )
    }
    const missing = canvas.getByRole("cell", { name: "—" })
    await expect(
      missing.querySelector(".bg-score-track")
    ).not.toBeInTheDocument()
    // Only percentages receive progress bars, not numeric counts.
    await expect(
      canvasElement.querySelectorAll(".bg-score-track")
    ).toHaveLength(3)
  },
}

export const Empty: Story = {
  args: { widget: metricWidget, result: emptyMetricResult, summary: null },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No current data")
    ).resolves.toBeVisible()
  },
}

function comparisonArgs(
  measure: string,
  current: number | null,
  previous: number | null,
  trendDirection?: DashboardWidget["trendDirection"]
) {
  const widget = {
    ...metricWidget,
    trendDirection,
    query: { ...metricWidget.query, measures: [measure] },
  }
  const result = semanticResultForQuery(widget.query)
  const prior = semanticResultForQuery(previousPeriodQuery(widget.query))
  result.data = [{ [measure]: current }]
  prior.data = [{ [measure]: previous }]
  return { widget, result, previous: prior }
}

function historyArgs(
  measure: string,
  current: number | null,
  values: (number | null)[]
) {
  const args = comparisonArgs(measure, current, 12)
  const history = semanticResultForQuery({
    ...args.widget.query,
    timeDimensions: args.widget.query.timeDimensions.map((time) => ({
      ...time,
      granularity: "day",
    })),
  })
  history.data = values.map((value, index) => ({
    [measure]: value,
    [history.query.timeDimensions[0].dimension]:
      `2026-09-${String(index + 8).padStart(2, "0")}`,
  }))
  return { ...args, history }
}

export const DailyHistory: Story = {
  args: historyArgs("traces.erroredCount", 6, [0, 4, 2]),
  play: async ({ canvasElement }) => {
    const user = userEvent.setup()
    const canvas = within(canvasElement)
    await expect(canvas.getByText("6", { exact: true })).toBeVisible()
    const chart = await canvas.findByRole("group", { name: /daily values/ })
    await waitFor(() =>
      expect(
        chart.querySelectorAll(".recharts-area-curve, .recharts-area-area")
      ).toHaveLength(2)
    )
    await expect(
      chart.querySelectorAll(
        ".recharts-cartesian-axis, .recharts-legend-wrapper, text"
      )
    ).toHaveLength(0)
    const area = chart.querySelector(".recharts-area-area")!
    const bounds = area.getBoundingClientRect()
    await user.pointer({
      target: area,
      coords: {
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      },
    })
    await expect(within(chart).findByText("Sep 9")).resolves.toBeVisible()
    await expect(within(chart).getByText("4", { exact: true })).toBeVisible()
    await user.unhover(area)
    await waitFor(() =>
      expect(within(chart).queryByText("Sep 9")).not.toBeInTheDocument()
    )
    const application = within(chart).getByRole("application")
    application.focus()
    await user.keyboard("{ArrowRight}")
    await expect(within(chart).findByText("Sep 9")).resolves.toBeVisible()
    await user.keyboard("{ArrowLeft}")
    await expect(within(chart).findByText("Sep 8")).resolves.toBeVisible()
    await expect(within(chart).getByText("0", { exact: true })).toBeVisible()
  },
}

export const DailyRateWithMissingDay: Story = {
  args: historyArgs("traces.errorRate", 0.2, [0.25, 0, null]),
  play: async ({ canvasElement }) => {
    const chart = await within(canvasElement).findByRole("group", {
      name: /daily values/,
    })
    await waitFor(() =>
      expect(chart.querySelectorAll(".recharts-area-curve")).toHaveLength(1)
    )
    await expect(
      chart.querySelectorAll("path.recharts-line-curve[stroke-dasharray]")
    ).toHaveLength(1)
    within(chart).getByRole("application").focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    await expect(within(chart).findByText("Sep 10")).resolves.toBeVisible()
    await expect(within(chart).getByText("No data")).toBeVisible()
  },
}

export const MissingAggregateHidesHistory: Story = {
  args: historyArgs("traces.erroredCount", null, [0, 4, 2]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("No current data")).toBeVisible()
    await expect(
      canvas.queryByRole("group", { name: /daily values/ })
    ).not.toBeInTheDocument()
  },
}

export const ImprovedFailures: Story = {
  args: comparisonArgs("traces.erroredCount", 12, 24),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("−50%", { exact: false })).toHaveClass(
      "text-success-foreground"
    )
    await expect(canvas.queryByText("Previous: 24")).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("vs previous period")
    ).not.toBeInTheDocument()
    const button = canvas.getByRole("button", { name: /−50%/ })
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.hover(button)
    await expect(body.findByRole("tooltip")).resolves.toHaveTextContent(
      "Previous: 24"
    )
    await userEvent.unhover(button)
    button.focus()
    await expect(body.findByRole("tooltip")).resolves.toHaveTextContent(
      "Previous: 24"
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(body.queryByRole("tooltip")).not.toBeInTheDocument()
    )
    await expect(canvas.getByText(", improved")).toBeInTheDocument()
  },
}

export const RegressedFailures: Story = {
  args: comparisonArgs("traces.erroredCount", 30, 24),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("+25%", { exact: false })).toHaveClass(
      "text-destructive"
    )
    await expect(canvas.getByText(", worsened")).toBeInTheDocument()
  },
}

export const FailureRateComparison: Story = {
  args: comparisonArgs("traces.errorRate", 0.12, 0.2),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("12%")).toBeVisible()
    await expect(canvas.getByText("−8 pp", { exact: false })).toHaveClass(
      "text-success-foreground"
    )
    await userEvent.hover(canvas.getByRole("button", { name: /−8 pp/ }))
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Previous: 20%")
  },
}

export const ZeroBaseline: Story = {
  args: comparisonArgs("traces.erroredCount", 5, 0),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("+5", { exact: false })).toHaveClass(
      "text-destructive"
    )
    await userEvent.hover(canvas.getByRole("button", { name: /\+5/ }))
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Previous: 0")
    await expect(canvas.queryByText(/Infinity|NaN/)).not.toBeInTheDocument()
  },
}

export const NoPreviousData: Story = {
  args: comparisonArgs("traces.errorRate", 0.12, null),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("No previous data")).toHaveClass(
      "text-foreground-muted"
    )
    await expect(canvas.queryByText(/Previous:/)).not.toBeInTheDocument()
  },
}

export const Unchanged: Story = {
  args: comparisonArgs("traces.erroredCount", 0, 0),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("No change")).toHaveClass(
      "text-foreground-muted"
    )
  },
}

export const DirectionOverride: Story = {
  args: comparisonArgs("traces.count", 180, 120, "increase"),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("+50%", { exact: false })
    ).toHaveClass("text-success-foreground")
  },
}

export const NeutralVolume: Story = {
  args: comparisonArgs("traces.count", 180, 120),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("+50%", { exact: false })
    ).toHaveClass("text-foreground-muted")
  },
}

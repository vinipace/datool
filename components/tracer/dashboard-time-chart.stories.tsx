import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { semanticResultForQuery } from "../../.storybook/scenarios/dashboards/fixtures"
import { dashboardTemplates } from "@/src/lib/tracer/dashboard-templates"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  emptyTtftResult,
  emptyTtftSummary,
  lineResult,
  lineSummary,
  lineWidget,
  stackedResult,
  stackedSummary,
  stackedWidget,
  ttftWidget,
} from "../../.storybook/scenarios/dashboards/fixtures"
import { DashboardTimeChart } from "./dashboard-time-chart"

const meta = {
  title: "Tracer/Dashboards/DashboardTimeChart",
  component: DashboardTimeChart,
  args: {
    widget: lineWidget,
    result: lineResult,
    summary: lineSummary,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/dashboards` },
    },
  },
  render: (args) => (
    <StorybookProjectFrame title="Dashboard chart">
      <div className="w-full max-w-2xl p-4">
        <DashboardTimeChart {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DashboardTimeChart>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByLabelText("Latency chart")).resolves.toBeVisible()
    await expect(canvas.findByText("P95 latency")).resolves.toBeVisible()
  },
}

export const Stacked: Story = {
  args: {
    widget: stackedWidget,
    result: stackedResult,
    summary: stackedSummary,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByLabelText("Spans chart")
    ).resolves.toBeVisible()
  },
}

export const NoFirstTokenData: Story = {
  args: {
    widget: ttftWidget,
    result: emptyTtftResult,
    summary: emptyTtftSummary,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No first-token timing recorded")
    ).resolves.toBeVisible()
  },
}

const modelWidget = dashboardTemplates
  .find((template) => template.id === "cost-and-usage")!
  .create(new Date("2026-09-11T00:00:00Z"))
  .widgets.find((widget) => widget.id === "cost-by-model")!
modelWidget.query.timeDimensions[0].dateRange = [
  "2026-09-08T00:00:00Z",
  "2026-09-11T00:00:00Z",
]
const modelResult = semanticResultForQuery(modelWidget.query)
modelResult.data = [
  {
    "spans.startedAt": "2026-09-08",
    "spans.model": "z-high-cost-model",
    "spans.costUsd": 8,
  },
  {
    "spans.startedAt": "2026-09-08",
    "spans.model": "unpriced-model",
    "spans.costUsd": null,
  },
  {
    "spans.startedAt": "2026-09-08",
    "spans.model": "gpt-5-mini",
    "spans.costUsd": 1,
  },
  {
    "spans.startedAt": "2026-09-08",
    "spans.model": "claude-sonnet-4",
    "spans.costUsd": 2,
  },
  {
    "spans.startedAt": "2026-09-09",
    "spans.model": "gpt-5-mini",
    "spans.costUsd": 0,
  },
  {
    "spans.startedAt": "2026-09-10",
    "spans.model": "gpt-5-mini",
    "spans.costUsd": 3,
  },
  {
    "spans.startedAt": "2026-09-10",
    "spans.model": "claude-sonnet-4",
    "spans.costUsd": 4,
  },
]
modelResult.meta.page.total = modelResult.data.length
const modelSummary = semanticResultForQuery({
  ...modelWidget.query,
  timeDimensions: modelWidget.query.timeDimensions.map(
    ({ dimension, dateRange }) => ({ dimension, dateRange })
  ),
})
modelSummary.data = [
  { "spans.model": "z-high-cost-model", "spans.costUsd": 8 },
  { "spans.model": "unpriced-model", "spans.costUsd": null },
  { "spans.startedAt": null, "spans.model": "gpt-5-mini", "spans.costUsd": 4 },
  {
    "spans.startedAt": null,
    "spans.model": "claude-sonnet-4",
    "spans.costUsd": 6,
  },
]

export const CostByModel: Story = {
  args: { widget: modelWidget, result: modelResult, summary: modelSummary },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("gpt-5-mini")).resolves.toBeVisible()
    await expect(canvas.findByText("claude-sonnet-4")).resolves.toBeVisible()
    await expect(canvas.getByText("$4.00", { selector: "span" })).toBeVisible()
    await expect(canvas.getByText("$6.00", { selector: "span" })).toBeVisible()
    await expect(canvas.queryByText("unpriced-model")).not.toBeInTheDocument()
    const legends = Array.from(
      canvasElement.querySelectorAll("span.font-medium")
    )
    await expect(legends.map((item) => item.textContent)).toEqual([
      "$8.00",
      "$6.00",
      "$4.00",
    ])
    const chart = canvas.getByRole("application")
    chart.focus()
    await userEvent.keyboard("{ArrowLeft}")
    const tooltipElement = canvasElement.querySelector(
      ".recharts-tooltip-wrapper"
    )!
    const tooltip = within(tooltipElement as HTMLElement)
    await waitFor(() => expect(tooltip.getByText("2026-09-08")).toBeVisible())
    await expect(
      Array.from(
        tooltipElement.querySelectorAll("strong"),
        (item) => item.textContent
      )
    ).toEqual(["$8.00", "$2.00", "$1.00"])
    await expect(tooltip.queryByText("unpriced-model")).not.toBeInTheDocument()
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() => expect(tooltip.getByText("2026-09-09")).toBeVisible())
    await expect(tooltip.getByText("gpt-5-mini")).toBeVisible()
    await expect(tooltip.getByText("$0.00")).toBeVisible()
    await expect(tooltip.queryByText("claude-sonnet-4")).not.toBeInTheDocument()
    await expect(
      tooltip.queryByText("z-high-cost-model")
    ).not.toBeInTheDocument()
    await expect(tooltip.queryByText("No data")).not.toBeInTheDocument()
  },
}

export const ModelStacked: Story = {
  args: { ...CostByModel.args, widget: { ...modelWidget, type: "stacked" } },
  play: CostByModel.play,
}

export const ModelEmpty: Story = {
  args: {
    widget: modelWidget,
    result: {
      ...modelResult,
      data: [],
      meta: {
        ...modelResult.meta,
        page: { ...modelResult.meta.page, total: 0 },
      },
    },
    summary: null,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No data")
    ).resolves.toBeVisible()
  },
}

export const ModelPartial: Story = {
  args: {
    ...CostByModel.args,
    result: {
      ...modelResult,
      meta: {
        ...modelResult.meta,
        page: { ...modelResult.meta.page, total: 6000 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("partial time series")
  },
}

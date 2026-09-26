import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, within } from "storybook/test"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  barMeasureAnnotation,
  barRows,
} from "../../.storybook/scenarios/dashboards/fixtures"
import { DashboardBarChart } from "./dashboard-bar-chart"

const meta = {
  title: "Tracer/Dashboards/DashboardBarChart",
  component: DashboardBarChart,
  args: {
    title: "Operations",
    rows: barRows,
    measure: "traces.count",
    dimensions: ["traces.operation"],
    annotation: barMeasureAnnotation,
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
        <DashboardBarChart {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DashboardBarChart>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByLabelText("Operations bar chart")
    ).resolves.toBeVisible()
    await expect(canvas.getByTitle("chat.completion")).toBeVisible()
    await expect(canvas.getByTitle("tool.weather")).toBeVisible()
  },
}

export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByLabelText("Operations bar chart")
    ).toBeVisible()
  },
}

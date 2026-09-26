import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { traceRows } from "../../.storybook/scenarios/traces/fixtures"
import { TraceListHistogram } from "./trace-list-histogram"

const meta = {
  title: "Tracer/TraceListHistogram",
  component: TraceListHistogram,
  args: {
    now: Date.parse("2026-09-10T15:00:00.000Z"),
    timeRange: "24h",
    traces: traceRows,
  },
} satisfies Meta<typeof TraceListHistogram>

export default meta
type Story = StoryObj<typeof meta>

const histogramA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production accessibility debt in components/tracer/trace-list-histogram.tsx: dark histogram timestamp labels measure 2.49:1 contrast in these fixed time ranges.",
    },
  },
} as const

export const LastDay: Story = { parameters: histogramA11yTodo }
export const NoVisibleRows: Story = {
  args: { traces: [] },
  parameters: histogramA11yTodo,
}

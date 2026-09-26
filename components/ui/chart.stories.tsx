import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./chart"

const traceVolume = [
  { day: "Mon", completed: 42, errored: 4 },
  { day: "Tue", completed: 58, errored: 6 },
  { day: "Wed", completed: 51, errored: 3 },
  { day: "Thu", completed: 67, errored: 8 },
]

const chartConfig = {
  completed: { label: "Completed", color: "var(--data-series-1)" },
  errored: { label: "Errored", color: "var(--destructive)" },
} satisfies ChartConfig

function TraceVolumeChart({ compact = false }: { compact?: boolean }) {
  return (
    <ChartContainer
      className={
        compact
          ? "min-h-64 w-[32rem] max-w-full"
          : "min-h-72 w-[42rem] max-w-full"
      }
      config={chartConfig}
    >
      <BarChart accessibilityLayer data={traceVolume}>
        {compact ? null : <CartesianGrid vertical={false} />}
        <XAxis axisLine={false} dataKey="day" tickLine={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent hideIndicator={compact} indicator="line" />
          }
        />
        <ChartLegend content={<ChartLegendContent hideIcon={compact} />} />
        <Bar dataKey="completed" fill="var(--color-completed)" radius={4} />
        {compact ? null : (
          <Bar dataKey="errored" fill="var(--color-errored)" radius={4} />
        )}
      </BarChart>
    </ChartContainer>
  )
}

const meta = {
  title: "UI/Chart",
  component: ChartContainer,
  render: () => <TraceVolumeChart />,
} satisfies Meta<typeof ChartContainer>

export default meta
type Story = StoryObj<typeof TraceVolumeChart>

export const TraceVolume: Story = {}

export const CompactLegend: Story = {
  render: () => <TraceVolumeChart compact />,
}

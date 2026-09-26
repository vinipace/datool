import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { PercentageCell } from "./percentage-cell"

const meta = {
  title: "Tracer/PercentageCell",
  component: PercentageCell,
  args: { value: 0.874 },
} satisfies Meta<typeof PercentageCell>

export default meta
type Story = StoryObj<typeof meta>

export const Measured: Story = {}
export const ErrorRate: Story = { args: { value: 0.2, tone: "destructive" } }
export const PassRate: Story = { args: { value: 0.8, tone: "success" } }
export const Missing: Story = { args: { value: null } }

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { LogTimestamp } from "./log-timestamp"

const meta = {
  title: "Tracer/LogTimestamp",
  component: LogTimestamp,
  args: { value: "2026-09-10T14:30:00.000Z" },
} satisfies Meta<typeof LogTimestamp>

export default meta
type Story = StoryObj<typeof meta>

export const Timestamp: Story = {}

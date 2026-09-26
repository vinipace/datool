import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { ResultIcon } from "./result-icon"

const meta = {
  title: "Tracer/ResultIcon",
  component: ResultIcon,
  args: { success: true },
} satisfies Meta<typeof ResultIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Passed: Story = {}
export const Failed: Story = { args: { success: false } }

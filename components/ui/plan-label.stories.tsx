import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { PlanLabel } from "./plan-label"

const meta = {
  title: "UI/PlanLabel",
  component: PlanLabel,
  args: { plan: "core" },
} satisfies Meta<typeof PlanLabel>

export default meta
type Story = StoryObj<typeof meta>

export const Core: Story = {}
export const Pro: Story = { args: { plan: "pro" } }
export const NoPlan: Story = { args: { plan: null } }
export const SelfHosted: Story = {
  args: { plan: null, billingEnabled: false },
}

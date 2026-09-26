import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { ScorerIcon } from "./scorer-icon"

const meta = {
  title: "Tracer/Scorers/ScorerIcon",
  component: ScorerIcon,
} satisfies Meta<typeof ScorerIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <span className="inline-flex items-center gap-2 text-foreground">
      <ScorerIcon aria-hidden="true" /> Scorer
    </span>
  ),
}

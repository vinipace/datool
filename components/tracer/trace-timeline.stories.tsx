import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, within } from "storybook/test"
import { traceOverview } from "../../.storybook/scenarios/traces/fixtures"
import { TraceTimeline } from "./trace-timeline"

const meta = {
  title: "Tracer/TraceTimeline",
  component: TraceTimeline,
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-full">
        <Story />
      </div>
    ),
  ],
  args: {
    onSelectSpan: fn(),
    selectedSpanId: "span-storybook-model",
    trace: traceOverview,
  },
} satisfies Meta<typeof TraceTimeline>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("button", { name: /Generate invoice response/ })
    ).resolves.toBeVisible()
  },
}
export const NoTiming: Story = {
  args: { trace: { ...traceOverview, spans: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "No captured span timing is available yet."
    )
  },
}

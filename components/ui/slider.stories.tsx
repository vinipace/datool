import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Slider } from "./slider"

const meta = {
  title: "UI/Slider",
  component: Slider,
  render: () => (
    <div className="grid w-80 gap-3">
      <span className="text-sm text-foreground">Sampling rate</span>
      <Slider aria-label="Sampling rate" defaultValue={[40]} />
    </div>
  ),
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const KeyboardControl: Story = {
  play: async ({ canvasElement }) => {
    const slider = within(canvasElement).getByRole("slider", {
      name: "Sampling rate",
    })
    await userEvent.click(slider)
    await userEvent.keyboard("{ArrowRight}")
    await expect(slider).toHaveAttribute("aria-valuenow", "41")
  },
}

export const RangeAndDisabled: Story = {
  render: () => (
    <div className="grid w-80 gap-5">
      <div className="grid gap-2">
        <span className="text-sm text-foreground">Accepted latency range</span>
        <Slider aria-label="Accepted latency range" defaultValue={[20, 80]} />
      </div>
      <div className="grid gap-2">
        <span className="text-sm text-foreground-muted">
          Locked sampling rate
        </span>
        <Slider
          disabled
          aria-label="Locked sampling rate"
          defaultValue={[60]}
        />
      </div>
    </div>
  ),
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Switch } from "./switch"

const meta = {
  title: "UI/Switch",
  component: Switch,
  args: { onCheckedChange: fn() },
  render: (args) => (
    <label className="flex items-center gap-3 text-sm text-foreground">
      <Switch {...args} aria-label="Enable live refresh" />
      Enable live refresh
    </label>
  ),
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Toggle: Story = {
  play: async ({ canvasElement, args }) => {
    const toggle = within(canvasElement).getByRole("switch", {
      name: "Enable live refresh",
    })
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(args.onCheckedChange).toHaveBeenCalledWith(true)
  },
}

export const CheckedAndDisabled: Story = {
  render: () => (
    <div className="grid gap-3">
      <label className="flex items-center gap-3 text-sm text-foreground">
        <Switch defaultChecked aria-label="Capture inputs" /> Capture inputs
      </label>
      <label className="flex items-center gap-3 text-sm text-foreground-muted">
        <Switch disabled aria-label="Enable retention" /> Enable retention
      </label>
    </div>
  ),
}

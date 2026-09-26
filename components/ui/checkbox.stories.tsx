import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Checkbox } from "./checkbox"

const meta = {
  title: "UI/Checkbox",
  component: Checkbox,
  args: { onChange: fn() },
  render: (args) => (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Checkbox {...args} />
      Include child spans
    </label>
  ),
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const checkbox = within(canvasElement).getByRole("checkbox", {
      name: "Include child spans",
    })
    await userEvent.click(checkbox)
    await expect(checkbox).toBeChecked()
    await expect(args.onChange).toHaveBeenCalledOnce()
  },
}

export const CheckedAndDisabled: Story = {
  render: () => (
    <div className="grid gap-3">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox defaultChecked /> Include child spans
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground-muted">
        <Checkbox disabled /> Persist selection
      </label>
    </div>
  ),
}

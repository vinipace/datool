import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Input } from "./input"

const meta = {
  title: "UI/Input",
  component: Input,
  args: { onChange: fn(), placeholder: "workflow-invoice" },
  render: (args) => (
    <label className="grid w-80 gap-2 text-sm text-foreground">
      Workflow name
      <Input {...args} />
    </label>
  ),
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Typing: Story = {
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole("textbox", {
      name: "Workflow name",
    })
    await userEvent.type(input, "invoice-extractor")
    await expect(input).toHaveValue("invoice-extractor")
    await expect(args.onChange).toHaveBeenCalled()
  },
}

export const InvalidAndDisabled: Story = {
  render: () => (
    <div className="grid w-80 gap-4">
      <label className="grid gap-2 text-sm text-foreground">
        API key
        <Input invalid defaultValue="too-short" aria-describedby="key-error" />
        <span id="key-error" className="text-xs text-destructive">
          Enter at least 16 characters.
        </span>
      </label>
      <label className="grid gap-2 text-sm text-foreground-muted">
        Project slug
        <Input disabled defaultValue="billing" />
      </label>
    </div>
  ),
}

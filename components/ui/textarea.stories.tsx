import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Textarea } from "./textarea"

const meta = {
  title: "UI/Textarea",
  component: Textarea,
  args: { onChange: fn(), placeholder: "Describe the scorer's intent" },
  render: (args) => (
    <label className="grid w-96 gap-2 text-sm text-foreground">
      Description
      <Textarea {...args} />
    </label>
  ),
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Typing: Story = {
  play: async ({ canvasElement, args }) => {
    const textarea = within(canvasElement).getByRole("textbox", {
      name: "Description",
    })
    await userEvent.type(
      textarea,
      "Checks whether extraction preserved totals."
    )
    await expect(textarea).toHaveValue(
      "Checks whether extraction preserved totals."
    )
    await expect(args.onChange).toHaveBeenCalled()
  },
}

export const InvalidAndDisabled: Story = {
  render: () => (
    <div className="grid w-96 gap-4">
      <label className="grid gap-2 text-sm text-foreground">
        Prompt notes
        <Textarea invalid defaultValue="" aria-describedby="notes-error" />
        <span id="notes-error" className="text-xs text-destructive">
          Add a note before saving.
        </span>
      </label>
      <label className="grid gap-2 text-sm text-foreground-muted">
        Immutable result
        <Textarea
          disabled
          defaultValue="This response belongs to an archived run."
        />
      </label>
    </div>
  ),
}

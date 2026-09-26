import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Select } from "./select"

const meta = {
  title: "UI/Select",
  component: Select,
  args: { defaultValue: "all", onChange: fn() },
  render: (args) => (
    <label className="grid w-72 gap-2 text-sm text-foreground">
      Trace status
      <Select {...args}>
        <option value="all">All statuses</option>
        <option value="completed">Completed</option>
        <option value="errored">Errored</option>
      </Select>
    </label>
  ),
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Selection: Story = {
  play: async ({ canvasElement, args }) => {
    const select = within(canvasElement).getByRole("combobox", {
      name: "Trace status",
    })
    await userEvent.selectOptions(select, "errored")
    await expect(select).toHaveValue("errored")
    await expect(args.onChange).toHaveBeenCalledOnce()
  },
}

export const InvalidAndDisabled: Story = {
  render: () => (
    <div className="grid w-72 gap-4">
      <label className="grid gap-2 text-sm text-foreground">
        Aggregation
        <Select invalid defaultValue="">
          <option value="">Choose an aggregation</option>
          <option value="average">Average</option>
        </Select>
      </label>
      <label className="grid gap-2 text-sm text-foreground-muted">
        Saved view
        <Select disabled defaultValue="default">
          <option value="default">Default view</option>
        </Select>
      </label>
    </div>
  ),
}

import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { ChartBar, ChartLine, Hash } from "lucide-react"
import { Combobox, ComboboxMultiple } from "./combobox"

const options = [
  { value: "metric", label: "Metric tile", icon: Hash },
  { value: "line", label: "Line chart", icon: ChartLine },
  { value: "bar", label: "Bar chart", icon: ChartBar },
]
const meta = {
  title: "UI/Combobox",
  component: Combobox,
  args: {
    label: "Chart type",
    options,
    value: "metric",
    onValueChange: () => {},
  },
  render: function Example(args) {
    const [value, setValue] = useState(args.value)
    return (
      <div className="w-64">
        <Combobox {...args} value={value} onValueChange={setValue} />
      </div>
    )
  },
} satisfies Meta<typeof Combobox>
export default meta
type Story = StoryObj<typeof meta>

export const SearchAndSelect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Chart type" }))
    await expect(body.findByRole("listbox", { name: "Chart type options" })).resolves.toBeVisible()
    const search = await body.findByRole("combobox", {
      name: "Search chart type",
    })
    await userEvent.type(search, "no matching chart")
    await expect(body.getByText("No options found.")).toBeVisible()
    await userEvent.clear(search)
    await userEvent.type(search, "line")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await expect(
      canvas.getByRole("combobox", { name: "Chart type" })
    ).toHaveTextContent("Line chart")
    await waitFor(() => expect(body.queryByRole("listbox")).not.toBeInTheDocument())
    await userEvent.click(canvas.getByRole("combobox", { name: "Chart type" }))
    await waitFor(() => expect(body.getByRole("combobox", { name: "Search chart type" })).toHaveFocus())
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("listbox")).not.toBeInTheDocument())
  },
}
export const Disabled: Story = { args: { disabled: true } }

export const MultipleSelection: Story = {
  render: function MultipleExample() {
    const [value, setValue] = useState(["metric"])
    return (
      <div className="w-80">
        <ComboboxMultiple
          options={options}
          label="Chart types"
          value={value}
          onValueChange={setValue}
          minSelected={1}
        />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const input = canvas.getByRole("combobox", { name: "Chart types" })
    await expect(
      canvas.getByRole("button", { name: "Remove Metric tile" })
    ).toHaveAttribute("aria-disabled", "true")
    await userEvent.type(input, "line")
    await userEvent.click(
      await body.findByRole("option", { name: "Line chart" })
    )
    await expect(
      canvas.getByRole("button", { name: "Remove Line chart" })
    ).toBeVisible()
    await waitFor(() => expect(body.queryByRole("listbox")).not.toBeInTheDocument())
    await userEvent.type(input, "bar")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await expect(
      canvas.getByRole("button", { name: "Remove Bar chart" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Metric tile" })
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove Metric tile" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Bar chart" })
    )
    await expect(
      canvas.getByRole("button", { name: "Remove Line chart" })
    ).toHaveAttribute("aria-disabled", "true")
  },
}

export const EscapeKeepsSelection: Story = {
  render: function Example() {
    const [value, setValue] = useState(["line"])
    return (
      <div className="w-80">
        <ComboboxMultiple
          options={options}
          label="Selected charts"
          value={value}
          onValueChange={setValue}
        />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("combobox", { name: "Selected charts" })
    await userEvent.click(input)
    await userEvent.keyboard("{Escape}{Escape}")
    await expect(
      canvas.getByRole("button", { name: "Remove Line chart" })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Line chart" })
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove Line chart" })
    ).not.toBeInTheDocument()
  },
}

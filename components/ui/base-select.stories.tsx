import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./base-select"

const environments = [
  { value: "development", label: "Development" },
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
]

function EnvironmentSelect({
  disabled = false,
  initialOpen = false,
  variant = "default",
}: {
  disabled?: boolean
  initialOpen?: boolean
  variant?: "default" | "ghost"
}) {
  const [open, setOpen] = React.useState(initialOpen)
  const [value, setValue] = React.useState("development")

  return (
    <div className="grid w-72 gap-2">
      <span className="text-sm text-foreground-muted">Environment</span>
      <Select
        disabled={disabled}
        items={environments}
        open={open}
        value={value}
        onOpenChange={setOpen}
        onValueChange={(next) => {
          if (next) setValue(next)
        }}
      >
        <SelectTrigger aria-label="Project environment" variant={variant}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {environments.map((environment) => (
            <SelectItem key={environment.value} value={environment.value}>
              {environment.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <output className="text-xs text-foreground-muted">
        Selected: {value}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/BaseSelect",
  component: Select,
  render: () => <EnvironmentSelect />,
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Selection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole("combobox", {
      name: "Project environment",
    })
    await userEvent.click(trigger)
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Production",
      })
    ).resolves.toBeVisible()
    await userEvent.keyboard("{End}{Enter}")
    await expect(canvas.getByText("Selected: production")).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    // Base UI retains hidden options for typeahead; wait for the popup to close.
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).queryByRole("listbox")
      ).not.toBeInTheDocument()
    )
  },
}

export const GhostAndDisabled: Story = {
  render: () => (
    <div className="flex items-start gap-8">
      <EnvironmentSelect variant="ghost" />
      <EnvironmentSelect disabled />
    </div>
  ),
}

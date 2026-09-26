import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within, waitFor } from "storybook/test"

import {
  StorySurface,
  demoRows,
  type DemoRow,
} from "@/.storybook/scenarios/datool/fixtures"
import { SearchBar, type SearchField } from "./index"

const fields = [
  {
    getValue: (row: DemoRow) => row.name,
    id: "name",
    kind: "text",
    sample: demoRows[0]?.name,
  },
  {
    getValue: (row: DemoRow) => row.status,
    id: "status",
    kind: "enum",
    options: ["complete", "pending", "review"],
  },
  {
    getValue: (row: DemoRow) => row.startedAt,
    id: "startedAt",
    kind: "date",
    sample: "2026-09-10T14:30:00.000Z",
  },
  {
    getValue: (row: DemoRow) => row.cost,
    id: "cost",
    kind: "number",
  },
] satisfies SearchField<DemoRow>[]

function ControlledSearch({
  syntax = "search",
  initialValue = "",
}: {
  syntax?: "filter" | "search"
  initialValue?: string
}) {
  const [value, setValue] = React.useState(initialValue)

  return (
    <div className="flex w-[min(100vw-2rem,40rem)] max-w-full flex-col gap-3">
      <SearchBar
        fields={fields}
        onSearchChange={setValue}
        placeholder={syntax === "filter" ? "Filter rows..." : "Search rows..."}
        syntax={syntax}
        value={value}
      />
      <output className="text-sm text-foreground-muted">
        {value || "No search"}
      </output>
    </div>
  )
}

const meta = {
  component: SearchBar,
  render: () => (
    <StorySurface>
      <ControlledSearch />
    </StorySurface>
  ),
  title: "Datool/SearchBar",
} satisfies Meta<typeof SearchBar>

export default meta
type Story = StoryObj

export const SearchSuggestions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const search = await canvas.findByRole("textbox", { name: "Search table" })

    await userEvent.click(search)
    await userEvent.type(search, "status:com")
    await expect(
      within(document.body).findByRole("button", { name: "complete" })
    ).resolves.toBeVisible()
    await userEvent.click(
      within(document.body).getByRole("button", { name: "complete" })
    )
    await expect(
      canvas.getByText("status:complete", { selector: "output" })
    ).toBeVisible()
  },
}

export const FilterExpression: Story = {
  render: () => (
    <StorySurface>
      <ControlledSearch syntax="filter" />
    </StorySurface>
  ),
}

export const StableSuggestionFocus: Story = {
  render: () => (
    <StorySurface>
      <ControlledSearch syntax="filter" />
    </StorySurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    input.focus()
    const panel = await body.findByRole("listbox", {
      name: "Filter suggestions",
    })
    // Clicking the already-focused anchor must not dismiss and remount its menu.
    await userEvent.click(input)
    await expect(panel).toBeInTheDocument()
    await expect(input).toHaveFocus()
    await userEvent.type(input, "invoice")
    await expect(panel).toBeInTheDocument()
    await expect(
      body.getByRole("option", { name: "invoice Full-text search" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(panel).not.toBeInTheDocument()
    await userEvent.click(input)
    await expect(
      body.getByRole("listbox", { name: "Filter suggestions" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("status"))
    await expect(
      body.queryByRole("listbox", { name: "Filter suggestions" })
    ).not.toBeInTheDocument()
  },
}

export const FloatingExpansion: Story = {
  render: () => (
    <StorySurface>
      <div className="w-80">
        <ControlledSearch
          syntax="filter"
          initialValue={
            'startedAt >= -7d "invoice" status = complete cost > 0.01'
          }
        />
      </div>
    </StorySurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    const surface = canvasElement.querySelector(
      '[data-slot="filter-bar-surface"]'
    )!
    const output = canvas.getByRole("status")
    const originalTop = output.getBoundingClientRect().top
    const collapsedHeight = surface.getBoundingClientRect().height
    await expect(collapsedHeight).toBe(36)
    input.focus()
    await waitFor(() =>
      expect(surface.getBoundingClientRect().height).toBeGreaterThan(
        collapsedHeight
      )
    )
    await expect(output.getBoundingClientRect().top).toBe(originalTop)
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Past 7 days" })
    )
    await expect(
      within(document.body).getByRole("dialog", { name: "Edit startedAt" })
    ).toBeVisible()
    await expect(surface.getBoundingClientRect().height).toBeGreaterThan(
      collapsedHeight
    )
    await expect(output.getBoundingClientRect().top).toBe(originalTop)
    await userEvent.keyboard("{Escape}")
    await userEvent.click(canvasElement)
    await waitFor(() =>
      expect(surface.getBoundingClientRect().height).toBe(collapsedHeight)
    )
    await expect(output.getBoundingClientRect().top).toBe(originalTop)
  },
}

export const InteractiveTokens: Story = {
  render: () => (
    <StorySurface>
      <ControlledSearch
        syntax="filter"
        initialValue={'startedAt >= -7d "foobar" status = complete cost > 0.01'}
      />
    </StorySurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const output = canvas.getByRole("status")
    await userEvent.click(canvas.getByRole("button", { name: 'Edit "foobar"' }))
    const text = body.getByRole("textbox", { name: "Full-text search" })
    await userEvent.clear(text)
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(body.getByRole("alert")).toHaveTextContent(
      "Search text must not be empty"
    )
    await userEvent.type(text, 'payment "failed"')
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(output).toHaveTextContent(
      'startedAt >= -7d "payment \\"failed\\"" status = complete cost > 0.01'
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Past 7 days" })
    )
    await userEvent.click(body.getByRole("button", { name: "Past 1 hour" }))
    await expect(output).toHaveTextContent("startedAt >= -1h")
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Status: Complete" })
    )
    await userEvent.selectOptions(body.getByLabelText("Status is"), "pending")
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(
      canvas.getByRole("button", { name: "Edit Status: Pending" })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Cost > 0.01" })
    )
    await expect(output).not.toHaveTextContent("cost")
    await expect(output).toHaveTextContent('status = "pending"')
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.type(input, 'name = "invoice"')
    await userEvent.keyboard("{Escape}{Enter}")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: 'Edit Name: "invoice"' })
      ).toBeVisible()
    )
    await expect(output).toHaveTextContent(
      'status = "pending" name = "invoice"'
    )
    await userEvent.click(
      canvas.getByRole("button", { name: 'Edit Name: "invoice"' })
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: 'Edit Name: "invoice"' })
      ).toHaveFocus()
    )
    await expect(
      canvas.queryByRole("button", { name: "Edit query" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await userEvent.type(input, '"replacement"')
    await userEvent.keyboard("{Enter}")
    await expect(
      canvas.getByRole("button", { name: 'Edit "replacement"' })
    ).toBeVisible()
    await expect(output).toHaveTextContent('"replacement"')
  },
}

export const CustomDateRange: Story = {
  render: () => (
    <StorySurface>
      <ControlledSearch
        syntax="filter"
        initialValue={'startedAt >= -7d "invoice"'}
      />
    </StorySurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Past 7 days" })
    )
    await userEvent.click(body.getByRole("button", { name: "Custom range…" }))
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(body.getByRole("alert")).toHaveTextContent(
      "Choose an end date after the start date"
    )
    // Native date inputs expose browser-specific segmented editing; paste through input events.
    const setDate = (label: string, value: string) => {
      const input = body.getByLabelText(label) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    setDate("From", "2026-09-01T09:00")
    setDate("To", "2026-09-13T18:00")
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(canvas.getByRole("status")).toHaveTextContent("startedAt <=")
    await expect(
      canvas.getByRole("button", { name: 'Edit "invoice"' })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Custom range" })
    )
    await userEvent.click(body.getByRole("button", { name: "Past 7 days" }))
    await expect(canvas.getByRole("status")).toHaveTextContent(
      'startedAt >= -7d "invoice"'
    )
    await expect(canvas.getByRole("status")).not.toHaveTextContent(
      "startedAt <="
    )
  },
}

function ExternalFilterExample() {
  const [value, setValue] = React.useState('"keep"')
  return (
    <StorySurface>
      <div className="w-96 max-w-full space-y-3">
        <SearchBar
          fields={fields}
          syntax="filter"
          value={value}
          onSearchChange={setValue}
        />
        <button
          type="button"
          onClick={() => setValue('startedAt >= -3d "saved view"')}
        >
          Load saved filter
        </button>
        <output>{value}</output>
      </div>
    </StorySurface>
  )
}

export const DraftAndExternalUpdates: Story = {
  render: () => <ExternalFilterExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.type(input, "status =")
    await expect(input).toHaveTextContent("status =")
    await userEvent.click(canvas.getByRole("button", { name: 'Edit "keep"' }))
    await userEvent.clear(
      body.getByRole("textbox", { name: "Full-text search" })
    )
    await userEvent.type(
      body.getByRole("textbox", { name: "Full-text search" }),
      "updated"
    )
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(canvas.getByRole("status")).toHaveTextContent('"updated"')
    await expect(canvas.getByRole("status")).not.toHaveTextContent("status =")
    await expect(input).toHaveTextContent("status =")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: 'Edit "updated"' })
      ).toHaveFocus()
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Load saved filter" })
    )
    await expect(
      canvas.getByRole("button", { name: 'Edit "saved view"' })
    ).toBeVisible()
    await expect(input).toHaveTextContent("")
    await userEvent.type(input, "status = ")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await expect(
      canvas.getByRole("button", { name: "Edit Status: Complete" })
    ).toBeVisible()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      'startedAt >= -3d "saved view" status = "complete"'
    )
  },
}

export const ReplacesTextSearch: Story = {
  render: () => (
    <StorySurface>
      <ControlledSearch
        syntax="filter"
        initialValue={
          'startedAt >= -7d "obsolete" "old phrase" status = complete name : "old phrase"'
        }
      />
    </StorySurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    const output = canvas.getByRole("status")
    await userEvent.type(input, "new search")
    await expect(output).toHaveTextContent('"old phrase" status = complete')
    await userEvent.keyboard("{Enter}")
    await expect(output).toHaveTextContent(
      'startedAt >= -7d "new search" status = complete name : "old phrase"'
    )
    await expect(
      canvas.queryByRole("button", { name: 'Edit "old phrase"' })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: 'Edit Name contains "old phrase"' })
    ).toBeVisible()
    await userEvent.type(input, '"newest" status != pending')
    await userEvent.click(
      within(document.body).getByRole("option", {
        name: '"newest" status != pending Add filter',
      })
    )
    await expect(output).toHaveTextContent(
      'startedAt >= -7d "newest" status = complete name : "old phrase" status != pending'
    )
    await expect(
      canvasElement.querySelectorAll('[data-filter-kind="fulltext"]')
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await userEvent.type(input, '"first" "last" status = pending')
    await userEvent.keyboard("{Enter}")
    await expect(output).toHaveTextContent('"last" status = pending')
    await expect(
      canvasElement.querySelectorAll('[data-filter-kind="fulltext"]')
    ).toHaveLength(1)
  },
}

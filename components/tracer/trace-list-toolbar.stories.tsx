import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { TraceListToolbar } from "./trace-list-toolbar"

function ToolbarExample({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = React.useState(initialQuery)
  return (
    <StorybookProjectFrame title="Traces">
      <TraceListToolbar
        filterError={null}
        isRefreshing={false}
        onDownloadCsv={() => {}}
        onDownloadJson={() => {}}
        onQueryChange={setQuery}
        onRefresh={() => {}}
        query={query}
      />
      <p className="p-4 text-sm text-foreground-muted">
        Current filter: {query || "all traces"}
      </p>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/TraceListToolbar",
  component: TraceListToolbar,
  parameters: { layout: "fullscreen" },
  render: () => <ToolbarExample />,
} satisfies Meta<typeof TraceListToolbar>

export default meta
type Story = StoryObj<typeof ToolbarExample>

const openMenuA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Open-menu axe finding in Storybook portal composition: keyboard focus on the More actions trigger leaves a focusable target in the hidden project frame portal host. Production impact is not separately verified.",
    },
  },
} as const

export const HeaderActions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "More actions" })
    )
    await expect(
      body.getByRole("menuitem", { name: "Export JSON" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.queryByRole("button", { name: "Display" })
    ).not.toBeInTheDocument()
  },
}

export const FixedDateFilter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const input = await canvas.findByRole("combobox", {
      name: "Filter expression",
    })
    await expect(
      canvas.queryByRole("button", { name: "Remove Past 3 days" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Past 3 days" })
    )
    await userEvent.click(body.getByRole("button", { name: "Past 7 days" }))
    await userEvent.type(input, "invoice{Enter}")
    await expect(
      canvas.getByRole("button", { name: 'Remove "invoice"' })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await expect(
      canvas.getByText("Current filter: startedAt >= -7d")
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Remove Past 7 days" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument()
    await userEvent.type(input, "payment{Enter}")
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await expect(
      canvas.getByRole("button", { name: "Edit Past 7 days" })
    ).toBeVisible()
    await expect(input).not.toHaveTextContent("startedAt")
    await userEvent.clear(input)
    await userEvent.type(input, "status = errored{Enter}")
    await expect(
      canvas.getByText("Current filter: startedAt >= -7d status = errored")
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Status: Errored" })
    )
    await expect(
      canvas.getByText("Current filter: startedAt >= -7d")
    ).toBeVisible()
  },
}

export const ValueOnlyFilterEditor: Story = {
  render: () => (
    <ToolbarExample
      initialQuery={
        'startedAt >= -3d groupName : ewewe metadata."resource.name" : "old"'
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const draft = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.click(
      canvas.getByRole("button", { name: /^Edit Group name contains/ })
    )
    const value = await body.findByRole("textbox", { name: "Group Name contains" })
    await expect(value).toHaveValue("ewewe")
    await userEvent.clear(value)
    await userEvent.type(value, 'needs "quotes" \\ path')
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: /^Edit / })).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Edit Group name contains/ })).toHaveFocus()
    )
    await expect(
      canvas.getByRole("button", { name: /^Edit Group name contains/ })
    ).toHaveAttribute(
      "title",
      'groupName contains "needs \\"quotes\\" \\\\ path"'
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /^Edit metadata/ })
    )
    const nestedValue = await body.findByRole("textbox", {
      name: 'metadata."resource.name" contains',
    })
    await expect(nestedValue).toHaveValue("old")
    await userEvent.clear(nestedValue)
    await userEvent.type(nestedValue, "null")
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: /^Edit / })).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Edit metadata/ })).toHaveFocus()
    )
    await expect(
      canvas.getByRole("button", { name: /^Edit metadata/ })
    ).toHaveAttribute("title", 'metadata."resource.name" contains "null"')
    await userEvent.type(draft, "unsubmitted")
    await userEvent.click(
      canvas.getByRole("button", { name: /^Edit Group name contains/ })
    )
    await userEvent.click(await body.findByRole("button", { name: "Remove" }))
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: /^Edit / })).not.toBeInTheDocument()
    )
    await waitFor(() => expect(draft).toHaveFocus())
    await expect(
      canvas.queryByRole("button", { name: /^Edit Group name contains/ })
    ).not.toBeInTheDocument()
    await expect(draft).toHaveTextContent("unsubmitted")
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Past 3 days" })
    )
    await expect(
      within(await body.findByRole("dialog", { name: "Edit startedAt" })).queryByRole(
        "button",
        { name: "Remove" }
      )
    ).not.toBeInTheDocument()
  },
}

export const OpenActionsMenu: Story = {
  parameters: openMenuA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const actions = await canvas.findByRole("button", { name: "More actions" })
    actions.focus()
    await userEvent.keyboard("{Enter}")
    await expect(
      body.findByRole("menuitem", { name: "Export JSON" })
    ).resolves.toBeVisible()
  },
}

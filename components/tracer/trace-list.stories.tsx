import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http, HttpResponse } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { traceHandlers } from "../../.storybook/scenarios/traces/handlers"
import {
  envelope,
  list,
  storybookTraceId,
  traceRows,
} from "../../.storybook/scenarios/traces/fixtures"
import { InspectorPanels } from "./inspector-panels"
import { TraceListWorkspace } from "./trace-list"

const settingsKey = `datool:traces-table-settings:${storybookProject.organizationId}:${storybookProject.projectId}`

const meta = {
  title: "Tracer/TraceListWorkspace",
  component: TraceListWorkspace,
  beforeEach: () => {
    localStorage.removeItem(settingsKey)
  },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: traceHandlers },
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/traces`, query: {} },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Traces">
      <InspectorPanels>
        <TraceListWorkspace />
      </InspectorPanels>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof TraceListWorkspace>

export default meta
type Story = StoryObj<typeof meta>

const traceListA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production accessibility debt in components/tracer/trace-list.tsx, components/tracer/trace-list-histogram.tsx, and components/tracer/trace-list-table.tsx: dark timestamps measure 2.49:1, trace summaries measure 3.99:1 to 4.34:1, and overflow trace metadata at trace-list-table.tsx:71 measures 3.73:1 contrast in this populated workspace.",
    },
  },
} as const

export const PopulatedWorkspace: Story = {
  parameters: traceListA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      canvas.findByText("Resolve invoice question")
    ).resolves.toBeVisible()
    const pageHeader = within(
      canvas.getByRole("banner", { name: "Page controls" })
    )
    const controls = within(
      canvas.getByRole("group", { name: "Traces controls" })
    )
    await expect(
      pageHeader.queryByRole("combobox", { name: "Filter expression" })
    ).not.toBeInTheDocument()
    await expect(
      pageHeader.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument()
    await expect(
      controls.getByRole("combobox", { name: "Filter expression" })
    ).toBeVisible()
    await expect(
      controls.getByRole("button", { name: "Refresh" })
    ).toBeVisible()
    await expect(
      canvas.getAllByRole("button", { name: "Display" })
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await expect(body.findByText("Visible columns")).resolves.toBeVisible()
    const input = body.getByRole("menuitemcheckbox", { name: "Input" })
    await expect(input).toHaveAttribute("aria-checked", "true")
    await userEvent.click(input)
    await expect(input).toHaveAttribute("aria-checked", "false")
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.queryByRole("columnheader", { name: "Input" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(body.getByRole("menuitemcheckbox", { name: "Input" }))
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.getByRole("columnheader", { name: "Input" })
    ).toBeVisible()
    await waitFor(() =>
      expect(
        controls.getByRole("button", { name: "Display" })
      ).toHaveFocus()
    )
    await userEvent.click(
      controls.getByRole("button", { name: "More actions" })
    )
    await expect(
      body.getByRole("menuitem", { name: "Export JSON" })
    ).toBeVisible()
    await expect(
      body.getByRole("menuitem", { name: "Export CSV" })
    ).toBeVisible()
    await expect(body.queryByRole("menuitem", { name: "Refresh" })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  },
}

function PersistentDisplayExample() {
  const [mount, setMount] = useState(0)
  return <StorybookProjectFrame title="Traces">
    <Button variant="outline" onClick={() => setMount(value => value + 1)}>Remount traces</Button>
    <InspectorPanels key={mount}><TraceListWorkspace /></InspectorPanels>
  </StorybookProjectFrame>
}

export const PersistentDisplay: Story = {
  parameters: traceListA11yTodo,
  render: () => <PersistentDisplayExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const openDisplay = async () => userEvent.click(await canvas.findByRole("button", { name: "Display" }))
    const remount = async () => {
      await userEvent.click(canvas.getByRole("button", { name: "Remount traces" }))
      await canvas.findByText("Resolve invoice question")
    }
    await canvas.findByText("Resolve invoice question")
    await waitFor(() => {
      for (const row of canvas.getAllByRole("row", { name: /^Open / })) {
        expect(row.getBoundingClientRect().height).toBe(40)
      }
    })
    await openDisplay()
    await expect(body.getByRole("menuitemradio", { name: "Compact" })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(body.getByRole("menuitemcheckbox", { name: "Input" }))
    await userEvent.click(body.getByRole("menuitemradio", { name: "Tall" }))
    await remount()
    await expect(canvas.queryByRole("columnheader", { name: "Input" })).not.toBeInTheDocument()
    await waitFor(() => expect(canvas.getAllByRole("row", { name: /^Open / }).some(row => row.getBoundingClientRect().height > 40)).toBe(true))
    await openDisplay()
    await expect(body.getByRole("menuitemradio", { name: "Tall" })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(body.getByRole("menuitemradio", { name: "Card" }))
    await remount()
    await expect(canvas.getByLabelText("Collection cards scroll area")).toBeVisible()
    await expect(canvas.queryByRole("term", { name: "Input" })).not.toBeInTheDocument()
    await openDisplay()
    await userEvent.click(body.getByRole("menuitemcheckbox", { name: "Input" }))
    await userEvent.click(body.getByRole("menuitemradio", { name: "Compact" }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Display" })).toHaveFocus()
    )
    await waitFor(() => {
      for (const row of canvas.getAllByRole("row", { name: /^Open / })) {
        expect(row.getBoundingClientRect().height).toBe(40)
      }
    })
  },
}

export const SplitWorkspace: Story = {
  parameters: {
    ...traceListA11yTodo,
    nextjs: {
      navigation: {
        pathname: `${storybookProject.prefix}/traces`,
        query: { trace: storybookTraceId },
      },
    },
  },
  render: () => (
    <div className="w-[1000px] max-w-full">
      <StorybookProjectFrame title="Traces">
        <InspectorPanels>
          <TraceListWorkspace />
        </InspectorPanels>
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const divider = await canvas.findByRole("separator", {
      name: "Resize inspector",
    })
    const controls = canvas.getByRole("group", { name: "Traces controls" })
    const header = canvas.getByRole("banner", { name: "Page controls" })
    await expect(
      canvas.findByRole("button", { name: "Close trace inspector" })
    ).resolves.toBeVisible()
    await expect(controls.getBoundingClientRect().right).toBeLessThanOrEqual(
      divider.getBoundingClientRect().right
    )
    await expect(
      Math.abs(
        controls.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom
      )
    ).toBeLessThan(1)
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    const toolbarHeight = controls.getBoundingClientRect().height
    await expect(within(controls).getByRole("button", { name: "Refresh" })).toBeVisible()
    // Resizing must keep the toolbar on one row inside the table panel.
    divider.focus()
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}")
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await expect(controls.getBoundingClientRect().height).toBe(toolbarHeight)
    await expect(
      within(controls).getByRole("button", { name: "Display" })
    ).toBeVisible()
    await waitFor(() => expect(within(controls).queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument())
    await userEvent.click(within(controls).getByRole("button", { name: "More actions" }))
    await expect(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: "Refresh" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    divider.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
    await waitFor(() => expect(within(controls).getByRole("button", { name: "Refresh" })).toBeVisible())
    await expect(controls.getBoundingClientRect().height).toBe(toolbarHeight)
  },
}

export const NarrowWorkspace: Story = {
  parameters: traceListA11yTodo,
  render: () => (
    <div className="w-[300px] max-w-full">
      <StorybookProjectFrame title="Traces">
        <TraceListWorkspace />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Resolve invoice question")
    const controls = canvas.getByRole("group", { name: "Traces controls" })
    const filter = within(controls).getByRole("search", { name: "Filter traces" })
    const menu = within(controls).getByRole("button", { name: "More actions" })
    await waitFor(() => expect(within(controls).queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument())
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await expect(menu.getBoundingClientRect().top).toBeLessThan(
      filter.getBoundingClientRect().bottom
    )
    await expect(filter.getBoundingClientRect().width).toBeGreaterThan(120)
    await expect(controls.getBoundingClientRect().height).toBeLessThan(60)
    const dateFilter = within(filter).getByRole("button", { name: "Edit Past 3 days" })
    await expect(dateFilter.getBoundingClientRect().right).toBeLessThan(filter.getBoundingClientRect().right)
    await expect(
      within(controls).getByRole("button", { name: "More actions" })
    ).toBeVisible()
    await userEvent.click(filter.querySelector("svg")!)
    const expression = within(filter).getByRole("combobox", { name: "Filter expression" })
    await waitFor(() => expect(expression).toHaveFocus())
    await expect(controls.getBoundingClientRect().height).toBeLessThan(60)
    const surface = filter.querySelector('[data-slot="filter-bar-surface"]')!
    await expect(surface.getBoundingClientRect().width).toBe(controls.clientWidth - 24)
    await expect(surface.getBoundingClientRect().right).toBe(controls.getBoundingClientRect().right - 12)
    await userEvent.keyboard("{Escape}")
    menu.focus()
    await expect(surface.getBoundingClientRect().width).toBe(filter.getBoundingClientRect().width)
    await userEvent.click(menu)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(body.getByRole("menuitem", { name: "Refresh" }))
    await waitFor(() =>
      expect(body.queryByRole("menu")).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(menu).toHaveFocus()
    )
  },
}

export const LoadingWorkspace: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay("infinite")
          return HttpResponse.json(envelope(list([])))
        }),
        ...traceHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading trace logs")).resolves.toBeVisible()
    await expect(
      within(canvas.getByRole("group", { name: "Traces controls" })).getByRole(
        "button",
        { name: "Refresh" }
      )
    ).toBeVisible()
  },
}

export const EmptyWorkspace: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", ({ request }) =>
          HttpResponse.json(
            envelope(
              list(
                new URL(request.url).searchParams.has("filter") ? [] : traceRows
              )
            )
          )
        ),
        ...traceHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("No matching traces")).resolves.toBeVisible()
    await expect(
      within(canvas.getByRole("group", { name: "Traces controls" })).getByRole(
        "combobox",
        { name: "Filter expression" }
      )
    ).toBeVisible()
  },
}

export const FailedWorkspace: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () =>
          HttpResponse.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Trace service unavailable",
              },
            },
            { status: 500 }
          )
        ),
        ...traceHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Trace service unavailable")
    ).resolves.toBeVisible()
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
    await expect(
      within(canvas.getByRole("group", { name: "Traces controls" })).getByRole(
        "button",
        { name: "Refresh" }
      )
    ).toBeVisible()
  },
}

export const SelectionHeader: Story = {
  parameters: traceListA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const controls = within(canvas.getByRole("group", { name: "Traces controls" }))
    const selectAll = await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    await userEvent.click(selectAll)
    await expect(controls.getByRole("button", { name: "Clear selection (2 selected)" })).toBeVisible()
    for (const name of ["Review", "Add To", "Download", "Tag", "Score", "Delete"]) {
      const button = controls.getByRole("button", { name })
      await expect(button).toBeVisible()
      await expect(button.getBoundingClientRect().height).toBe(32)
    }
    await expect(controls.queryByRole("combobox", { name: "Filter expression" })).not.toBeInTheDocument()
    await expect(controls.queryByRole("button", { name: "Display" })).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("checkbox", { name: /^Select trace 1:/ }))
    await expect(selectAll).toBePartiallyChecked()
    await expect(controls.getByRole("button", { name: "Clear selection (1 selected)" })).toBeVisible()
    await userEvent.click(controls.getByRole("button", { name: "Clear selection (1 selected)" }))
    await expect(selectAll).not.toBeChecked()
    await expect(controls.getByRole("combobox", { name: "Filter expression" })).toBeVisible()
    await expect(controls.getByRole("button", { name: "Display" })).toBeVisible()
  },
}

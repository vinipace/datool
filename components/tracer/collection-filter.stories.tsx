import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"

const searchRows = [
  {
    id: "invoice",
    name: "Billing reply",
    status: "errored",
    output: { messages: [{ text: "Invoice payment failed" }] },
  },
  {
    id: "greeting",
    name: "Greeting",
    status: "completed",
    output: { text: "Hello there" },
  },
]

function FullTextExample({ isLoading = false }: { isLoading?: boolean }) {
  const search = useCollectionFilter("traces")
  const rows = searchRows.filter(
    compileCollectionFilter("traces", search.filter)
  )
  return (
    <StorybookProjectFrame title="Trace filters">
      <div className="space-y-4 p-4">
        <CollectionFilterBar
          resource="traces"
          {...search}
          isLoading={isLoading}
        />
        <output aria-label="Applied query">
          {search.value || "No filter"}
        </output>
        <div aria-label="Search results">
          {rows.map((row) => (
            <p key={row.id}>{row.name}</p>
          ))}
          {!rows.length && <p>No matching traces</p>}
        </div>
      </div>
    </StorybookProjectFrame>
  )
}

function FilterExample() {
  const [value, setValue] = React.useState('status = "completed"')
  return (
    <StorybookProjectFrame title="Trace filters">
      <div className="p-4">
        <CollectionFilterBar
          error={null}
          onChange={setValue}
          resource="traces"
          value={value}
        />
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/CollectionFilterBar",
  component: CollectionFilterBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    const originalUrl = window.location.href
    return () => window.history.replaceState(null, "", originalUrl)
  },
  render: () => <FilterExample />,
} satisfies Meta<typeof CollectionFilterBar>

export default meta
type Story = StoryObj<typeof FilterExample>

export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const filter = await canvas.findByRole("search", { name: "Filter traces" })
    const input = within(filter).getByRole("combobox")
    await userEvent.click(input)
    await userEvent.clear(input)
    await userEvent.keyboard('name = "invoice"')
    await expect(input).toHaveTextContent('name = "invoice"')
  },
}

export const ContainsFilter: Story = {
  render: () => <FullTextExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(document.body)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.type(input, "name")
    const suggestion = body.getByRole("option", { name: "name contains" })
    await expect(suggestion.querySelector(".token.operator")).toHaveTextContent(
      "contains"
    )
    await userEvent.click(suggestion)
    await expect(input).toHaveTextContent("name contains")
    await userEvent.type(input, "BILL")
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      "No filter"
    )
    await userEvent.click(
      body.getByRole("option", { name: "name contains BILL Add filter" })
    )
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      "name contains BILL"
    )
    await waitFor(() =>
      expect(canvas.getByLabelText("Search results")).not.toHaveTextContent(
        "Greeting"
      )
    )
    await expect(canvas.getByLabelText("Search results")).toHaveTextContent(
      "Billing reply"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: 'Edit Name contains "BILL"' })
    )
    const value = body.getByRole("textbox", { name: "Name contains" })
    await userEvent.clear(value)
    await userEvent.type(value, "greet")
    await userEvent.click(body.getByRole("button", { name: "Update" }))
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      'name contains "greet"'
    )
    await waitFor(() =>
      expect(canvas.getByLabelText("Search results")).toHaveTextContent(
        "Greeting"
      )
    )
    await expect(canvas.getByLabelText("Search results")).not.toHaveTextContent(
      "Billing reply"
    )
  },
}

export const InvalidFilter: Story = {
  render: () => (
    <StorybookProjectFrame title="Trace filters">
      <div className="p-4">
        <CollectionFilterBar
          error="Expected a value after status ="
          onChange={() => {}}
          resource="traces"
          value="status ="
        />
      </div>
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Filter expression" })
    )
    await expect(
      within(document.body).getByRole("option", {
        name: "status = Full-text search",
      })
    ).toBeVisible()
  },
}

export const FullTextSearch: Story = {
  render: () => <FullTextExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    const results = within(canvas.getByLabelText("Search results"))
    await userEvent.click(input)
    await userEvent.keyboard('"INVOICE" status = errored')
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      "No filter"
    )
    await expect(results.getByText("Greeting")).toBeVisible()
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(results.queryByText("Greeting")).not.toBeInTheDocument()
    )
    await expect(results.getByText("Billing reply")).toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.tab()
    await expect(canvas.getByText('"INVOICE"', { exact: true })).toBeVisible()
    await userEvent.click(input)
    await userEvent.keyboard("werwer")
    await expect(
      within(document.body).getByRole("option", {
        name: "werwer Full-text search",
      })
    ).toBeVisible()
    await userEvent.tab()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      '"INVOICE" status = errored'
    )
    await expect(results.getByText("Billing reply")).toBeVisible()
    await userEvent.clear(input)
    await userEvent.keyboard("absent")
    await userEvent.click(
      within(document.body).getByRole("option", {
        name: "absent Full-text search",
      })
    )
    await waitFor(() =>
      expect(results.getByText("No matching traces")).toBeVisible()
    )
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await waitFor(() => expect(results.getByText("Greeting")).toBeVisible())
    await expect(results.getByText("Billing reply")).toBeVisible()
  },
}

export const Loading: Story = {
  render: () => <FullTextExample isLoading />,
}

export const UrlPersistence: Story = {
  render: () => <FullTextExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const url = new URL(window.location.href)
    url.searchParams.set("trace", "selected-trace")
    url.hash = "details"
    window.history.replaceState(null, "", url)
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.click(input)
    await userEvent.keyboard('startedAt >= -30d "café & billing"')
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      const current = new URL(window.location.href)
      expect(current.searchParams.get("filter")).toBe(
        'startedAt >= -30d "café & billing"'
      )
      expect(current.searchParams.get("trace")).toBe("selected-trace")
      expect(current.hash).toBe("#details")
    })
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await waitFor(() => {
      const current = new URL(window.location.href)
      expect(current.searchParams.has("filter")).toBe(true)
      expect(current.searchParams.get("filter")).toBe("")
    })
  },
}

export const RestoredFromUrl: Story = {
  parameters: {
    nextjs: { navigation: { query: { filter: '"INVOICE" status = errored' } } },
  },
  render: () => <FullTextExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Applied query")).toHaveTextContent(
      '"INVOICE" status = errored'
    )
    await expect(canvas.getByLabelText("Search results")).toHaveTextContent("Billing reply")
    await expect(canvas.getByLabelText("Search results")).not.toHaveTextContent("Greeting")
  },
}

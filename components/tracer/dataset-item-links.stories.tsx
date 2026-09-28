import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"
import { delay, http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { datasetDetail, datasetItems, list, storybookDatasetId } from "../../.storybook/scenarios/datasets-evals/fixtures"
import { data, datasetsEvalsHandlers, failure } from "../../.storybook/scenarios/datasets-evals/handlers"
import { storybookReactView } from "../../.storybook/scenarios/react-views"
import { datasetItemPreview } from "@/src/lib/tracer/dataset-payload"
import type { DatasetItemField } from "@/src/lib/tracer/contracts"
import { DatasetDetailPage } from "./datasets-page"

const item = { ...datasetItems[0], id: "linked-item", versionId: "v1", input: { text: "x".repeat(40000), tail: "complete" }, metadata: { text: "m".repeat(40000) } }
const view = { ...storybookReactView, id: "linked-view", name: "Shared item view", code: `import * as React from "react";
export default function View({ trace }) {
  React.useEffect(() => { parent.postMessage({ type: "linked-item-render", trace }, "*") }, [trace]);
  return <main>Rendered: {trace.input.tail}</main>;
}` }
const otherView = { ...view, id: "other-view", name: "Other item view" }
const reads = fn()
const lookup = fn()
const rendered = fn()
let failRead = false

// Storybook does not install Next's history integration. Mirror it for real history tests.
function LocationFrame() {
  const [url, setUrl] = React.useState(() => new URL(window.location.href))
  React.useEffect(() => {
    const push = window.history.pushState
    const replace = window.history.replaceState
    const sync = () => setUrl(new URL(window.location.href))
    window.history.pushState = function (...args) { push.apply(this, args); sync() }
    window.history.replaceState = function (...args) { replace.apply(this, args); sync() }
    window.addEventListener("popstate", sync)
    return () => {
      window.history.pushState = push
      window.history.replaceState = replace
      window.removeEventListener("popstate", sync)
    }
  }, [])
  return <PathnameContext.Provider value={url.pathname}><SearchParamsContext.Provider value={url.searchParams}>
    <StorybookProjectFrame title="" breadcrumbs={[{ label: "Datasets", href: "/p/demo/datasets" }]}><div className="flex min-h-0 flex-1">
      <DatasetDetailPage datasetId={storybookDatasetId} />
    </div></StorybookProjectFrame>
  </SearchParamsContext.Provider></PathnameContext.Provider>
}
const datasetPath = `/p/demo/datasets/${storybookDatasetId}`
function start(itemId: string | null, query = "") {
  const original = window.location.href
  const url = new URL(original)
  url.pathname = itemId ? `${datasetPath}/${itemId}` : datasetPath
  for (const key of ["item", "itemTab", "objectView", "filter"]) url.searchParams.delete(key)
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value)
  window.history.replaceState(null, "", url)
  reads.mockClear(); lookup.mockClear(); rendered.mockClear(); failRead = false
  const receive = (event: MessageEvent) => { if (event.data?.type === "linked-item-render") rendered(event.data.trace) }
  window.addEventListener("message", receive)
  return () => { window.removeEventListener("message", receive); window.history.replaceState(null, "", original) }
}
const handlers = [
  http.post("/api/agent/get_view_preference", () => data({ revision: 1, value: { id: otherView.id } })),
  http.post("/api/agent/save_view_preference", () => data({ revision: 2, value: {} })),
  http.get("/api/page-views", () => data(list([]))),
  http.get("/api/custom-fields", () => data([])),
  http.get("/api/datasets/:datasetId", () => data({ ...datasetDetail, fieldSchemas: {}, items: [] })),
  http.get("/api/datasets/:datasetId/items", async ({ request }) => {
    const url = new URL(request.url)
    expect(url.searchParams.get("preview")).toBe("true")
    const filter = url.searchParams.get("filter")
    if (filter?.startsWith("id =")) {
      lookup(filter)
      await delay(200)
      return data(list(filter === 'id = "linked-item"' ? [datasetItemPreview(item)] : []))
    }
    return data(list(datasetItems))
  }),
  http.get("/api/dataset-items/:itemId", async ({ request }) => {
    const fields = new URL(request.url).searchParams.get("fields")!.split(",") as DatasetItemField[]
    reads(fields)
    await delay(250)
    if (failRead) { failRead = false; return failure("Could not load view data", 503) }
    return data(datasetItemPreview(item, fields))
  }),
  http.get("/api/object-views", () => data(list([view, otherView]))),
  http.get("/api/object-views/:id", ({ params }) => {
    const selected = [view, otherView].find(row => row.id === params.id)
    return selected ? data(selected) : failure("View not found", 404)
  }),
  ...datasetsEvalsHandlers,
]
const meta = {
  title: "Tracer/Datasets/ItemLinks",
  component: DatasetDetailPage,
  args: { datasetId: storybookDatasetId },
  parameters: { layout: "fullscreen", nextjs: { navigation: { pathname: `/p/demo/datasets/${storybookDatasetId}` } }, msw: { handlers } },
  render: () => <LocationFrame />,
  beforeEach: () => start("linked-item", "itemTab=views&objectView=linked-view"),
} satisfies Meta<typeof DatasetDetailPage>
export default meta
type Story = StoryObj<typeof meta>

export const SharedLargeItem: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const load = await page.findByRole("button", { name: "Load and render" })
    expect(lookup).toHaveBeenCalledWith('id = "linked-item"')
    expect(page.getByRole("combobox", { name: "View" })).toHaveTextContent(view.name)
    expect(reads).not.toHaveBeenCalled()
    expect(rendered).not.toHaveBeenCalled()
    expect(page.queryByTitle("React view preview")).not.toBeInTheDocument()
    load.focus()
    expect(load).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    expect(page.getByRole("button", { name: "Loading and rendering…" })).toBeDisabled()
    await waitFor(() => expect(rendered).toHaveBeenCalled(), { timeout: 15000 })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(reads).toHaveBeenCalledWith(["input", "metadata"])
    expect(rendered.mock.calls.at(-1)?.[0].input).toEqual(item.input)
    expect(rendered.mock.calls.at(-1)?.[0].attributes).toEqual(item.metadata)
  },
}
export const DeferredPreview: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await page.findByRole("button", { name: "Load and render" })
    expect(page.getByRole("combobox", { name: "View" })).toHaveTextContent(view.name)
    expect(reads).not.toHaveBeenCalled()
  },
}
export const LoadFailureAndRetry: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    failRead = true
    await userEvent.click(await page.findByRole("button", { name: "Load and render" }))
    await page.findByText("Could not load view data")
    expect(page.getByRole("combobox", { name: "View" })).toHaveTextContent(view.name)
    expect(page.queryByTitle("React view preview")).not.toBeInTheDocument()
    await userEvent.click(page.getByRole("button", { name: "Load and render" }))
    await waitFor(() => expect(rendered).toHaveBeenCalled(), { timeout: 15000 })
    expect(reads).toHaveBeenCalledTimes(2)
  },
}
export const HistoryAndSelection: Story = {
  beforeEach: () => start(null, "filter="),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const row = await page.findByRole("row", { name: "Open dataset row 1" })
    const url = new URL(location.href)
    url.searchParams.set("filter", "")
    window.history.replaceState(null, "", url)
    await userEvent.click(row)
    expect(location.pathname).toBe(`${datasetPath}/${datasetItems[0].id}`)
    expect(new URLSearchParams(location.search).get("itemTab")).toBe("form")
    await userEvent.click(page.getByRole("button", { name: "Views" }))
    await waitFor(() => expect(new URLSearchParams(location.search).get("objectView")).toBe(otherView.id))
    await waitFor(() => expect(page.getByRole("combobox", { name: "View" })).toBeEnabled())
    await userEvent.click(page.getByRole("combobox", { name: "View" }))
    await userEvent.click(await page.findByRole("option", { name: view.name }))
    await waitFor(() => expect(new URLSearchParams(location.search).get("objectView")).toBe(view.id))
    await userEvent.click(page.getByRole("button", { name: "Next row" }))
    expect(location.pathname).toBe(`${datasetPath}/${datasetItems[1].id}`)
    expect(new URLSearchParams(location.search).get("itemTab")).toBe("views")
    expect(new URLSearchParams(location.search).get("filter")).toBe("")
    window.history.back()
    await waitFor(() => expect(location.pathname).toBe(`${datasetPath}/${datasetItems[0].id}`))
    await waitFor(() => expect(page.getByLabelText("Dataset row inspector")).toHaveTextContent(datasetItems[0].id.slice(-8)))
    window.history.back()
    await waitFor(() => expect(page.getByRole("combobox", { name: "View" })).toHaveTextContent(otherView.name))
    window.history.forward()
    await waitFor(() => expect(page.getByRole("combobox", { name: "View" })).toHaveTextContent(view.name))
    await userEvent.click(page.getByRole("button", { name: "Close row" }))
    expect(page.queryByLabelText("Dataset row inspector")).not.toBeInTheDocument()
    expect(location.pathname).toBe(datasetPath)
    expect(new URLSearchParams(location.search).has("objectView")).toBe(false)
    expect(new URLSearchParams(location.search).get("filter")).toBe("")
  },
}
export const MissingItem: Story = {
  beforeEach: () => start("deleted-item", "itemTab=views"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await page.findByText("This dataset item is unavailable or has been deleted.")
    await userEvent.click(page.getByRole("button", { name: "Close row" }))
    expect(location.pathname).toBe(datasetPath)
  },
}
export const MissingView: Story = {
  beforeEach: () => start("linked-item", "itemTab=views&objectView=deleted-view"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await page.findByText(/The linked view is unavailable/)
    expect(reads).not.toHaveBeenCalled()
    expect(page.queryByTitle("React view preview")).not.toBeInTheDocument()
    await userEvent.click(page.getByRole("combobox", { name: "View" }))
    await userEvent.click(await page.findByRole("option", { name: view.name }))
    await page.findByRole("button", { name: "Load and render" })
    expect(new URLSearchParams(location.search).get("objectView")).toBe(view.id)
  },
}

export const RunsDeepLink: Story = {
  beforeEach: () => start("linked-item", "itemTab=runs"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(page.getByRole("button", { name: "Runs", pressed: true })).toBeVisible())
    expect(reads).not.toHaveBeenCalled()
    await userEvent.click(page.getByRole("button", { name: "Form" }))
    await page.findByRole("button", { name: "Load Input" })
    expect(new URLSearchParams(location.search).get("itemTab")).toBe("form")
    window.history.back()
    await waitFor(() => expect(page.getByRole("button", { name: "Runs", pressed: true })).toBeVisible())
  },
}

export const SwitchWhileLoading: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(await page.findByRole("button", { name: "Load and render" }))
    await userEvent.click(page.getByRole("button", { name: "Previous row" }))
    await waitFor(() => expect(rendered.mock.calls.at(-1)?.[0].input).toEqual(datasetItems[1].input), { timeout: 15000 })
    expect(location.pathname).toBe(`${datasetPath}/${datasetItems[1].id}`)
    window.history.back()
    await page.findByRole("button", { name: "Load and render" })
    expect(location.pathname).toBe(`${datasetPath}/${item.id}`)
    expect(page.queryByTitle("React view preview")).not.toBeInTheDocument()
  },
}

export const EmptyLibrary: Story = {
  beforeEach: () => start("linked-item", "itemTab=views"),
  parameters: { msw: { handlers: [http.get("/api/object-views", () => data(list([]))), ...handlers] } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await page.findByText("Create a view from the view menu to get started.")
    expect(reads).not.toHaveBeenCalled()
    expect(page.getByRole("combobox", { name: "View" })).toBeEnabled()
  },
}

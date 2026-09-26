import { checkCollectionSelection } from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { delay, http, HttpResponse } from "msw"
import { columnWorkerSource } from "@/src/lib/tracer/column-worker-source"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  datasetDetail,
  datasetItems,
  list,
  storybookDatasetId,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { DatasetDetailPage, DatasetsPage } from "./datasets-page"

const meta = {
  title: "Tracer/Datasets/DatasetPages",
  component: DatasetDetailPage,
  args: { datasetId: storybookDatasetId },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: {
        pathname: "/p/demo/datasets/dataset-storybook-support",
      },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Datasets">
      <div className="flex min-h-0 flex-1">
        <DatasetDetailPage datasetId={storybookDatasetId} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DatasetDetailPage>

export default meta
type Story = StoryObj<typeof meta>

const datasetFieldsKey = `datool:dataset-fields:storybook-organization:storybook-project:${storybookDatasetId}`
const questionField: ComputedColumn = {
  id: "dataset-question",
  name: "Question",
  code: "row.input.question",
  mode: "expression",
  format: "text",
}
const priorityField: ComputedColumn = {
  id: "dataset-priority",
  name: "Priority",
  code: "row.metadata.priority",
  mode: "expression",
  format: "text",
}
const saveDatasetItem = fn()

export const CustomFieldsInRowPanel: Story = {
  beforeEach: () => {
    localStorage.setItem(datasetFieldsKey, JSON.stringify([questionField]))
    saveDatasetItem.mockClear()
    return () => localStorage.removeItem(datasetFieldsKey)
  },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/custom-fields", () => data([questionField, priorityField])),
        http.get("/api/eval-column-worker", () => new HttpResponse(columnWorkerSource, {
          headers: { "Content-Type": "text/javascript" },
        })),
        http.patch("/api/dataset-items/:itemId", () => {
          saveDatasetItem()
          return data(datasetItems[0])
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(await canvas.findByRole("row", { name: "Open dataset row 1" }))
    const inspector = within(await canvas.findByLabelText("Dataset row inspector"))
    await expect(inspector.findByText("Where is my latest invoice?")).resolves.toBeVisible()

    await userEvent.click(inspector.getByRole("combobox", { name: "Add custom field" }))
    await expect(page.findByRole("option", { name: "Priority" })).resolves.toBeVisible()
    await expect(page.queryByRole("option", { name: "Question" })).not.toBeInTheDocument()
    await userEvent.click(page.getByRole("option", { name: "Priority" }))
    await expect(inspector.findByText("high")).resolves.toBeVisible()
    await expect(canvas.getByRole("columnheader", { name: "Priority" })).toBeInTheDocument()

    await userEvent.click(inspector.getByRole("button", { name: "Next row" }))
    await expect(inspector.findByText("normal")).resolves.toBeVisible()
    await expect(inspector.findByText("How do I change my payment method?")).resolves.toBeVisible()
    await userEvent.click(inspector.getByRole("combobox", { name: "Add custom field" }))
    await userEvent.click(await page.findByRole("button", { name: "Create new custom field" }))
    const dialog = within(await page.findByRole("dialog", { name: "Add custom field" }))
    await userEvent.type(dialog.getByLabelText("Column name"), "Input summary")
    const input = await dialog.findByRole("textbox", { name: "Template code" }, { timeout: 10000 })
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const editor = monaco.editor.getEditors().find((item) => item.getDomNode()?.contains(input))!
    await userEvent.click(input)
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await userEvent.paste("Summary: {{row.input.question}}")
    await userEvent.click(dialog.getByRole("button", { name: "Preview first row" }))
    await expect(dialog.findByText("Summary: How do I change my payment method?", { exact: true })).resolves.toBeVisible()
    await userEvent.click(dialog.getByRole("button", { name: "Add column" }))
    await waitFor(() => expect(page.queryByRole("dialog", { name: "Add custom field" })).not.toBeInTheDocument())
    await expect(inspector.findByText("Summary: How do I change my payment method?", { exact: true })).resolves.toBeVisible()
    await expect(canvas.getByRole("columnheader", { name: "Input summary" })).toBeInTheDocument()
    await waitFor(() => expect(JSON.parse(localStorage.getItem(datasetFieldsKey) ?? "[]")).toHaveLength(3))
    await expect(saveDatasetItem).not.toHaveBeenCalled()
    const disclosure = inspector.getByRole("button", { name: "Input summary Text" })
    await userEvent.click(disclosure)
    await expect(inspector.getByText("Summary: How do I change my payment method?", { exact: true })).not.toBeVisible()
    await userEvent.click(disclosure)
    await expect(inspector.getByText("Summary: How do I change my payment method?", { exact: true })).toBeVisible()
  },
}

export const Detail: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/custom-fields", () => data([])),
        http.get("/api/datasets/:datasetId/items", () =>
          data(list(datasetItems))
        ),
        http.get("/api/datasets/:datasetId", () => data(datasetDetail)),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getAllByRole("row")).toHaveLength(3))
    await userEvent.click(canvas.getAllByRole("row")[1])
    await expect(
      canvas.findByLabelText("Dataset row inspector")
    ).resolves.toBeVisible()
  },
}

export const EmptyRows: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/custom-fields", () => data([])),
        http.get("/api/datasets/:datasetId/items", () => data(list([]))),
        http.get("/api/datasets/:datasetId", () =>
          data({ ...datasetDetail, itemCount: 0, items: [] })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(
        "No rows yet. Add a row or import your examples."
      )
    ).resolves.toBeVisible()
  },
}

export const DetailLoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets/:datasetId/items", () => data(list([]))),
        http.get("/api/datasets/:datasetId", () =>
          failure("Dataset is unavailable")
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Dataset is unavailable")
    ).resolves.toHaveTextContent("Dataset is unavailable")
  },
}

export const LibraryExport: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  render: () => (
    <StorybookProjectFrame title="Datasets">
      <DatasetsPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("support")
    ).resolves.toBeVisible()
  },
}

export const SelectionHeader: Story = {
  ...LibraryExport,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Datasets"),
}

export const DetailSelectionHeader: Story = {
  parameters: Detail.parameters,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Dataset rows"),
}

export const DetailCardSelectionHeader: Story = {
  parameters: Detail.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: "Select row 1" })
    const controls = within(canvas.getByRole("group", { name: "Dataset rows controls" }))
    await userEvent.click(controls.getByRole("button", { name: "Display" }))
    await userEvent.click(within(document.body).getByRole("menuitemradio", { name: "Card" }))
    await expect(canvas.getByLabelText("Log cards scroll area")).toBeVisible()
    await checkCollectionSelection(canvasElement, "Dataset rows")
  },
}

export const RowsLoading: Story = {
  parameters: {
    msw: { handlers: [
      http.get("/api/datasets/:datasetId/items", async () => { await delay("infinite"); return data(list(datasetItems)) }),
      ...datasetsEvalsHandlers,
    ] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading dataset rows")).resolves.toBeVisible()
    await expect(canvas.queryByRole("group", { name: "Selected row actions" })).not.toBeInTheDocument()
  },
}

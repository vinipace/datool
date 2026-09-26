import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within, spyOn } from "storybook/test"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http, HttpResponse } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  dataset,
  evaluators,
  evalRun,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import {
  envelope,
  list,
  traceRows,
} from "../../.storybook/scenarios/traces/fixtures"
import { TraceSelectionActions } from "./trace-selection-actions"
import { CollectionPanel } from "./collection-panel"

const writes: { path: string; body: Record<string, unknown> }[] = []
const payloadReads: string[] = []
let failDelete = false
let slowCatalog = false
let emptyCatalog = false
let failCatalog = false

function Example({ width }: { width?: number }) {
  const [selected, setSelected] = React.useState(traceRows)
  return (
    <div style={{ width }} className="max-w-full">
      <StorybookProjectFrame title="Traces">
        <CollectionPanel
          label="Traces"
          selectionControls={
            selected.length ? (
              <TraceSelectionActions
                traces={selected}
                onClear={() => setSelected([])}
                onChanged={() => {}}
                onDeleted={(ids) =>
                  setSelected((current) =>
                    current.filter((trace) => !ids.includes(trace.id))
                  )
                }
              />
            ) : undefined
          }
        >
          <p className="p-3 text-sm text-foreground-muted">
            {selected.length} traces selected
          </p>
        </CollectionPanel>
      </StorybookProjectFrame>
    </div>
  )
}

const meta = {
  title: "Tracer/TraceSelectionActions",
  component: TraceSelectionActions,
  args: {
    traces: traceRows,
    onClear: () => {},
    onChanged: () => {},
    onDeleted: () => {},
  },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/traces", () =>
          HttpResponse.json(envelope(list(traceRows)))
        ),
        http.get("/api/human-scores", () =>
          HttpResponse.json(envelope({ scores: [], collections: [] }))
        ),
        http.get("/api/reviews/options", () =>
          HttpResponse.json(
            envelope({ members: [], currentUserId: "reviewer" })
          )
        ),
        http.get("/api/traces/:id/payload", ({ params }) => {
          payloadReads.push(String(params.id))
          return HttpResponse.json(
            envelope({
              ...traceRows.find((trace) => trace.id === params.id),
              input: { full: "Full input beyond the table preview" },
              output: { full: "Full output beyond the table preview" },
            })
          )
        }),
        http.get("/api/datasets", async () => {
          if (slowCatalog) await delay("infinite")
          if (failCatalog)
            return HttpResponse.json(
              { error: { message: "Dataset catalog unavailable" } },
              { status: 500 }
            )
          return HttpResponse.json(
            envelope(list(emptyCatalog ? [] : [dataset]))
          )
        }),
        http.get("/api/evaluators", () =>
          HttpResponse.json(envelope(list(evaluators)))
        ),
        http.post(
          /\/api\/(traces\/selection|agent\/bulk_dataset_items|evals|reviews)$/,
          async ({ request }) => {
            const path = new URL(request.url).pathname
            const body = (await request.json()) as Record<string, unknown>
            writes.push({ path, body })
            if (body.action === "delete" && failDelete)
              return HttpResponse.json(
                {
                  error: {
                    message:
                      "Selected traces are used by a review. No traces were deleted.",
                  },
                },
                { status: 409 }
              )
            return HttpResponse.json(
              envelope(
                path === "/api/evals"
                  ? evalRun
                  : path === "/api/reviews"
                    ? { id: "review-created", number: 355 }
                    : { traceIds: body.traceIds }
              )
            )
          }
        ),
      ],
    },
  },
  beforeEach: () => {
    writes.length = 0
    payloadReads.length = 0
    failDelete = false
    slowCatalog = false
    emptyCatalog = false
    failCatalog = false
  },
  render: () => <Example />,
} satisfies Meta<typeof TraceSelectionActions>
export default meta
type Story = StoryObj<typeof meta>

export const CompactSelection: Story = {}
export const NarrowSelection: Story = {
  render: () => <Example width={300} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const controls = canvas.getByRole("group", { name: "Traces controls" })
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await expect(controls.getBoundingClientRect().height).toBeLessThan(60)
    for (const name of [
      "Review",
      "Add To",
      "Download",
      "Tag",
      "Score",
      "Delete",
    ]) {
      const button = canvas.getByRole("button", { name })
      await expect(button).toBeVisible()
      await expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        controls.getBoundingClientRect().right
      )
    }
  },
}

export const ReviewSelection: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/traces" } },
  },
  play: async ({ canvasElement }) => {
    getRouter().push.mockClear()
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Review" }))
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument()
    await expect(getRouter().push).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/p\/demo\/reviews\/review_[\da-f-]+$/
      )
    )
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        path: "/api/reviews",
        body: {
          idempotencyKey: expect.any(String),
          traceIds: traceRows.map((trace) => trace.id),
        },
      })
    )
  },
}

export const DatasetSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Add To" }))
    const dialog = within(
      await body.findByRole("dialog", { name: "Add to dataset" })
    )
    const picker = dialog.getByRole("combobox", { name: "Dataset" })
    await waitFor(() => expect(picker).not.toBeDisabled())
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: dataset.name })
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Add to dataset" })
    )
    await waitFor(() => expect(writes).toHaveLength(1))
    await expect(writes[0]).toMatchObject({
      path: "/api/agent/bulk_dataset_items",
      body: {
        datasetId: dataset.id,
        create: traceRows.map((trace) => ({
          sourceTraceId: trace.id,
          input: { full: "Full input beyond the table preview" },
          expectedOutput: null,
        })),
      },
    })
    await expect(payloadReads).toEqual(traceRows.map((trace) => trace.id))
    await waitFor(() =>
      expect(body.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Add To" })).toHaveFocus()
    )
  },
}

export const TagSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Tag" }))
    const dialog = within(
      await body.findByRole("dialog", { name: "Tag traces" })
    )
    await userEvent.type(dialog.getByLabelText("Tag"), "needs-review")
    await userEvent.click(dialog.getByRole("button", { name: "Add tag" }))
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        path: "/api/traces/selection",
        body: {
          action: "tag",
          traceIds: traceRows.map((trace) => trace.id),
          tags: ["needs-review"],
        },
      })
    )
    await waitFor(() =>
      expect(body.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Tag" })).toHaveFocus()
    )
  },
}

export const ScoreSelection: Story = {
  parameters: { nextjs: { navigation: { pathname: "/p/demo/traces" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Score" }))
    const dialog = within(
      await body.findByRole("dialog", { name: "Score traces" })
    )
    await expect(
      dialog.getByRole("button", { name: "Run scorers" })
    ).toBeDisabled()
    await userEvent.click(dialog.getByRole("button", { name: "Choose scorers" }))
    const newScorer = await body.findByRole("link", { name: "New scorer" })
    const query = new URL(newScorer.getAttribute("href")!, "http://localhost")
      .searchParams
    await expect(query.get("traceIds")).toBe(
      traceRows.map((trace) => trace.id).join(",")
    )
    const picker = dialog.getByRole("combobox", { name: "Scorers" })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.type(picker, evaluators[0].name)
    const first = await body.findByRole("option", {
      name: new RegExp(evaluators[0].name),
    })
    await expect(first).toHaveTextContent(evaluators[0].description!)
    await expect(first).toHaveTextContent("JS")
    await expect(first.querySelector("svg.lucide-triangle")).toBeInTheDocument()
    await waitFor(() => {
      const rect = first.getBoundingClientRect()
      expect(
        first.contains(
          canvasElement.ownerDocument.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          )
        )
      ).toBe(true)
    })
    await userEvent.click(first)
    await userEvent.type(picker, evaluators[1].name)
    await userEvent.click(
      await body.findByRole("option", { name: new RegExp(evaluators[1].name) })
    )
    await expect(
      dialog.getByRole("button", { name: `Remove ${evaluators[0].name}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: `Remove ${evaluators[1].name}` })
    ).toBeVisible()
    await userEvent.click(
      dialog.getByRole("button", { name: `Remove ${evaluators[0].name}` })
    )
    await userEvent.type(picker, evaluators[0].name)
    await userEvent.click(
      await body.findByRole("option", { name: new RegExp(evaluators[0].name) })
    )

    await userEvent.click(dialog.getByRole("button", { name: "Run scorers" }))
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        path: "/api/evals",
        body: {
          mode: "traces",
          background: true,
          traceIds: traceRows.map((trace) => trace.id),
          evaluatorIds: [evaluators[1].id, evaluators[0].id],
        },
      })
    )
    await waitFor(() =>
      expect(body.queryByRole("dialog")).not.toBeInTheDocument()
    )
  },
}

export const DownloadSelection: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const createUrl = spyOn(URL, "createObjectURL")
    try {
      await userEvent.click(
        within(canvasElement).getByRole("button", {
          name: "Download",
        })
      )
      await userEvent.click(
        body.getByRole("menuitem", { name: "Download JSON" })
      )
      await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
      const blob = createUrl.mock.calls[0][0] as Blob
      const exported = JSON.parse(await blob.text())
      await expect(exported.map((trace: { id: string }) => trace.id)).toEqual(
        traceRows.map((trace) => trace.id)
      )
      await expect(exported[0].input).toEqual({
        full: "Full input beyond the table preview",
      })
      await waitFor(() =>
        expect(
          within(canvasElement).getByRole("button", {
            name: "Download",
          })
        ).not.toBeDisabled()
      )
    } finally {
      createUrl.mockRestore()
    }
  },
}

export const DeleteConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const remove = canvas.getByRole("button", { name: "Delete" })
    await userEvent.click(remove)
    let dialog = within(
      await body.findByRole("alertdialog", { name: "Delete 2 traces?" })
    )
    await expect(writes).toHaveLength(0)
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(remove).toHaveFocus())
    await userEvent.click(remove)
    await body.findByRole("alertdialog", { name: "Delete 2 traces?" })
    await userEvent.keyboard("{Escape}")
    await expect(writes).toHaveLength(0)
    await waitFor(() => expect(remove).toHaveFocus())
    await userEvent.click(remove)
    dialog = within(
      await body.findByRole("alertdialog", { name: "Delete 2 traces?" })
    )
    await userEvent.click(dialog.getByRole("button", { name: "Delete traces" }))
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        body: {
          action: "delete",
          traceIds: traceRows.map((trace) => trace.id),
        },
      })
    )
    await expect(canvas.findByText("0 traces selected")).resolves.toBeVisible()
  },
}

export const DeleteFailure: Story = {
  beforeEach: () => {
    failDelete = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Delete" }))
    const dialog = within(await body.findByRole("alertdialog"))
    await userEvent.click(dialog.getByRole("button", { name: "Delete traces" }))
    await waitFor(() =>
      expect(dialog.getByText(/No traces were deleted/)).toBeVisible()
    )
    await expect(canvas.getByText("2 traces selected")).toBeInTheDocument()
  },
}

export const LoadingDatasets: Story = {
  beforeEach: () => {
    slowCatalog = true
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add To" })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByText("Loading datasets")
    ).resolves.toBeVisible()
  },
}
export const EmptyDatasets: Story = {
  beforeEach: () => {
    emptyCatalog = true
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add To" })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByText(
        "Create a dataset to add these traces."
      )
    ).resolves.toBeVisible()
  },
}
export const FailedDatasets: Story = {
  beforeEach: () => {
    failCatalog = true
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add To" })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByText(
        "Dataset catalog unavailable"
      )
    ).resolves.toBeVisible()
  },
}

export const CreateFirstScorer: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/traces" } },
    msw: {
      handlers: [
        http.get("/api/evaluators", () =>
          HttpResponse.json(envelope(list([])))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Score" })
    )
    const dialog = within(
      await body.findByRole("dialog", { name: "Score traces" })
    )
    await expect(
      dialog.getByRole("button", { name: "Run scorers" })
    ).toBeDisabled()
    await userEvent.click(dialog.getByRole("button", { name: "Choose scorers" }))
    await expect(body.findByText("AutoEvals", { exact: true })).resolves.toBeVisible()
    await expect(body.getByRole("option", { name: /Exact match/ })).toBeVisible()
    const link = await body.findByRole("link", { name: "New scorer" })
    await expect(link).toHaveAttribute(
      "href",
      `/p/demo/scorers/new?${new URLSearchParams({ traceIds: traceRows.map((trace) => trace.id).join(",") })}`
    )
  },
}

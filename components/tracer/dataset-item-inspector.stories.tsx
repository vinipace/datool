import { useState } from "react"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http } from "msw"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import type { DatasetItem } from "@/src/lib/tracer/contracts"
import type { ValueView } from "@/src/lib/tracer/value-views"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  datasetItems,
  datasetSchemas,
  traceRows,
  list,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { itemDraft, jsonDocument } from "@/src/lib/tracer/dataset-editor"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  reactViewHandlers,
  storybookReactView,
} from "../../.storybook/scenarios/react-views"
import { ProjectScope } from "./project-scope-context"
import { DatasetItemInspector } from "./dataset-item-inspector"

function ItemInspectorExample({
  error,
  navigate = false,
  item = datasetItems[0],
  fieldViews = { input: "json", expectedOutput: "pretty", metadata: "tree" },
}: {
  error?: string
  navigate?: boolean
  item?: DatasetItem
  fieldViews?: Record<string, ValueView>
}) {
  const [currentItem, setCurrentItem] = useState(item)
  const [draft, setDraft] = useState(() => itemDraft(item))
  return (
    <DatasetItemInspector
      draft={draft}
      error={error}
      fieldViews={fieldViews}
      isNew={false}
      item={currentItem}
      onClose={fn()}
      onDelete={fn()}
      onDraftChange={setDraft}
      onFieldViewChange={fn()}
      onNext={
        navigate
          ? () => {
              setCurrentItem(datasetItems[1])
              setDraft(itemDraft(datasetItems[1]))
            }
          : fn()
      }
      onPrevious={fn()}
      onRetry={fn()}
      saving={false}
      schemas={datasetSchemas}
    />
  )
}

const meta = {
  title: "Tracer/Datasets/DatasetItemInspector",
  component: DatasetItemInspector,
  decorators: [
    (Story) => (
      <ProjectScope.Provider
        value={{
          projectId: "storybook-project",
          organizationId: "storybook-organization",
        }}
      >
        <Story />
      </ProjectScope.Provider>
    ),
  ],
  args: {
    draft: itemDraft(datasetItems[0]),
    fieldViews: {},
    isNew: false,
    item: datasetItems[0],
    onClose: fn(),
    onDelete: fn(),
    onDraftChange: fn(),
    onFieldViewChange: fn(),
    onRetry: fn(),
    saving: false,
    schemas: datasetSchemas,
  },
  beforeEach: () => {
    localStorage.removeItem("datool:project-react-view:storybook-project")
  },
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/datasets" } },
    msw: { handlers: reactViewHandlers() },
  },
  render: (args) => (
    <StorybookProjectFrame title="Billing FAQ">
      <div className="min-h-0 flex-1">
        <DatasetItemInspector {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DatasetItemInspector>

export default meta
type Story = StoryObj<typeof meta>

export const Editing: Story = {
  render: () => <ItemInspectorExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Next row" }))
    await expect(
      canvas.getByRole("link", { name: /trace-storybook-001/i })
    ).toHaveAttribute("href", "/p/demo/traces/trace-storybook-001")
  },
}

export const SaveFailure: Story = {
  render: () => <ItemInspectorExample error="Could not save this row." />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Could not save this row.")
  },
}

export const InvalidJson: Story = {
  args: {
    draft: {
      ...itemDraft(datasetItems[0]),
      input: { format: "json", text: "ewrwwew\nerwr\n" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByText(/is not valid JSON/)).toHaveLength(1)
    await expect(
      canvas.getByRole("alert").closest("details")
    ).toHaveTextContent("Input")
  },
}

export const InvalidMetadata: Story = {
  args: {
    draft: { ...itemDraft(datasetItems[0]), metadata: jsonDocument([]) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getAllByText("Metadata must be a JSON object.")
    ).toHaveLength(1)
    await expect(
      canvas.getByRole("alert").closest("details")
    ).toHaveTextContent("Metadata")
  },
}

export const SchemaViolation: Story = {
  args: {
    draft: {
      ...itemDraft(datasetItems[0]),
      input: jsonDocument({ question: "" }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const errors = canvas.getAllByText(/must NOT have fewer than 1 characters/)
    await expect(errors).toHaveLength(1)
    await expect(errors[0].closest("details")).toHaveTextContent("Input")
  },
}

export const AutoSizing: Story = {
  render: () => (
    <div className="h-[720px] w-96 max-w-full">
      <ItemInspectorExample
        item={{
          ...datasetItems[0],
          input: null,
          expectedOutput: null,
          metadata: {},
        }}
        fieldViews={{}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    for (const label of ["Row Input", "Row Expected", "Row Metadata"]) {
      const input = await canvas.findByRole(
        "textbox",
        { name: label },
        { timeout: 10000 }
      )
      const editor = monaco.editor
        .getEditors()
        .find((item) => item.getDomNode()?.contains(input))!
      const surface = editor.getDomNode()!
      await waitFor(() =>
        expect(surface.getBoundingClientRect().height).toBeLessThan(100)
      )
      const initialHeight = surface.getBoundingClientRect().height
      await userEvent.click(input)
      editor.trigger("storybook", "editor.action.selectAll", undefined)
      await userEvent.paste(
        JSON.stringify(
          { question: "A long wrapped dataset value. ".repeat(50) },
          null,
          2
        )
      )
      await waitFor(() => {
        expect(surface.getBoundingClientRect().height).toBeGreaterThan(300)
        expect(surface.getBoundingClientRect().height).toBe(
          editor.getContentHeight()
        )
      })
      editor.trigger("storybook", "editor.action.selectAll", undefined)
      await userEvent.paste(label === "Row Metadata" ? "{}" : "null")
      await waitFor(() =>
        expect(surface.getBoundingClientRect().height).toBe(initialHeight)
      )
    }
    await userEvent.click(
      canvas.getByRole("textbox", { name: "Source trace ID" })
    )
  },
}

const savedView = {
  ...storybookReactView,
  id: "shared-view",
  name: "Support · Question and answer",
  code: `import * as React from "react";
export default function View({ trace }: ViewProps) {
  React.useEffect(() => { parent.postMessage({ type: "dataset-view-rendered", trace }, "*"); }, [trace]);
  return <main><h2>{trace.input?.question}</h2><p>{trace.output?.answer}</p><small>{trace.attributes.locale}</small></main>;
}`,
}

export const SharedViews: Story = {
  parameters: { msw: { handlers: reactViewHandlers([savedView]) } },
  render: () => (
    <div className="h-[640px]">
      <ItemInspectorExample navigate />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const rendered: { input: unknown; output: unknown; attributes: unknown }[] =
      []
    const receive = (event: MessageEvent) => {
      if (event.data?.type === "dataset-view-rendered")
        rendered.push(event.data.trace)
    }
    window.addEventListener("message", receive)
    try {
      const sections = canvas.getByRole("navigation", {
        name: "Dataset row inspector sections",
      })
      expect(
        within(sections)
          .getAllByRole("button")
          .map((button) => button.textContent)
      ).toEqual(["Form", "Runs", "Views"])
      await userEvent.click(canvas.getByRole("button", { name: "Views" }))
      await canvas.findByText("Select a project view to preview this record.")
      await userEvent.click(
        canvas.getByRole("combobox", { name: "React view" })
      )
      await userEvent.click(
        await within(canvasElement.ownerDocument.body).findByRole("option", {
          name: /Support · Question and answer/,
        })
      )
      await waitFor(() =>
        expect(
          canvas.getByRole("combobox", { name: "React view" })
        ).toHaveTextContent(savedView.name)
      )
      await userEvent.click(canvas.getByRole("button", { name: "View actions" }))
      await expect(
        within(canvasElement.ownerDocument.body).findByRole("menuitem", {
          name: "Edit view",
        })
      ).resolves.toBeVisible()
      await userEvent.keyboard("{Escape}")
      await waitFor(
        () =>
          expect(rendered.at(-1)?.output).toEqual(
            datasetItems[0].expectedOutput
          ),
        { timeout: 15000 }
      )
      expect(rendered.at(-1)?.attributes).toEqual(datasetItems[0].metadata)
      await userEvent.click(canvas.getByRole("button", { name: "Next row" }))
      await waitFor(() =>
        expect(rendered.at(-1)?.input).toEqual(datasetItems[1].input)
      )
      await userEvent.click(canvas.getByRole("button", { name: "Form" }))
      await expect(
        canvas.getByRole("textbox", { name: "Source trace ID" })
      ).toHaveValue("")
    } finally {
      window.removeEventListener("message", receive)
    }
  },
}

export const EmptyViews: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Views" }))
    await expect(
      await canvas.findByText(
        "Create a view from the view menu to get started."
      )
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("combobox", { name: "React view" }))
    await expect(
      within(
        await within(canvasElement.ownerDocument.body).findByRole("dialog", {
          name: "React view options",
        })
      ).getByRole("button", { name: "Create new view" })
    ).toBeVisible()
  },
}

export const InvalidViewValues: Story = {
  args: {
    draft: {
      ...itemDraft(datasetItems[0]),
      input: { format: "json", text: "{" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Views" }))
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Fix invalid row values in Form"
    )
  },
}

export const RowRuns: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", ({ request }) => {
          const query = new URL(request.url).searchParams
          if (query.get("datasetItemId") !== datasetItems[0].id)
            return failure("Wrong item filter")
          return data(
            query.get("cursor")
              ? list([traceRows[1]])
              : { items: [traceRows[0]], nextCursor: "page-2" }
          )
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Runs" }))
    const firstRow = await canvas.findByRole("row", {
      name: new RegExp(`Open ${traceRows[0].name}`),
    })
    await expect(
      canvas.getByRole("columnheader", { name: "Input" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("columnheader", { name: "Output" })
    ).toBeVisible()
    getRouter().push.mockClear()
    await userEvent.click(firstRow)
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      `/p/demo/traces/${traceRows[0].id}`
    )
    await userEvent.click(canvas.getByRole("button", { name: "Load more" }))
    const secondRow = await canvas.findByRole("row", {
      name: new RegExp(`Open ${traceRows[1].name}`),
    })
    secondRow.focus()
    await userEvent.keyboard("{Enter}")
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      `/p/demo/traces/${traceRows[1].id}`
    )
    getRouter().push.mockClear()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Select all visible traces" })
    )
    await expect(
      canvas.getByRole("checkbox", { name: /Select trace 1/ })
    ).toBeChecked()
    await expect(getRouter().push).not.toHaveBeenCalled()
    await userEvent.click(
      canvas.getByRole("button", { name: /^Clear selection/ })
    )
  },
}

export const RunsLoading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay("infinite")
          return data(list([]))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Runs" }))
    await expect(
      canvas.findByText("Loading row runs")
    ).resolves.toBeInTheDocument()
  },
}

export const RunsEmpty: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/traces", () => data(list([])))] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Runs" }))
    await expect(
      canvas.findByText("No runs for this row yet.")
    ).resolves.toBeVisible()
  },
}

export const RunsFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () => failure("Could not load row runs")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Runs" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Could not load row runs"
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

export const NewRowRuns: Story = {
  args: { isNew: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Runs" }))
    await expect(
      canvas.getByText("Save this row to see its runs.")
    ).toBeVisible()
  },
}

export const ProjectViews: Story = {
  parameters: { msw: { handlers: reactViewHandlers([storybookReactView]) } },
  loaders: [
    async () => {
      localStorage.removeItem("datool:project-react-view:storybook-project")
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Views" }))
    await canvas.findByText("Select a project view to preview this record.")
    await userEvent.click(canvas.getByRole("combobox", { name: "React view" }))
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Answer view",
      })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("combobox", { name: "React view" })
      ).toHaveTextContent("Answer view")
    )
    await userEvent.click(canvas.getByRole("button", { name: "View actions" }))
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("menuitem", {
        name: "Edit view",
      })
    ).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}

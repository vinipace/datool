import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { datasetsEvalsHandlers } from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  datasetItems,
  storybookDatasetId,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import {
  defaultTableSettings,
  type LogTableSettings,
} from "@/src/lib/tracer/custom-views"
import { DatasetItemsTable } from "./dataset-items-table"
import { useComputedColumns } from "./use-computed-columns"
import { useWorkspaceStorageScope } from "./workspace-path"

function DatasetItemsTableExample({
  items = datasetItems,
}: {
  items?: typeof datasetItems
}) {
  const storageScope = useWorkspaceStorageScope()
  const computed = useComputedColumns(
    `dataset:${storybookDatasetId}`,
    items,
    `datool:dataset-fields:${storageScope}:${storybookDatasetId}`
  )
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] =
    useState<LogTableSettings>(defaultTableSettings)
  return (
    <>
      <p className="sr-only" role="status">
        {selectedId ? `Selected ${selectedId}` : "No selected row"}
      </p>
      <DatasetItemsTable
        computed={computed}
        checked={checked}
        datasetId={storybookDatasetId}
        drafts={new Set()}
        filtered={false}
        items={items}
        onCheck={setChecked}
        onFieldViewChange={(field, view) =>
          setSettings((current) => ({
            ...current,
            fieldViews: { ...current.fieldViews, [field]: view },
          }))
        }
        onSelect={(item) => setSelectedId(item.id)}
        onSettingsChange={setSettings}
        selectedId={selectedId}
        settings={settings}
      />
    </>
  )
}

const meta = {
  title: "Tracer/Datasets/DatasetItemsTable",
  component: DatasetItemsTableExample,
  args: {
    items: datasetItems,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/datasets" } },
  },
  render: () => (
    <StorybookProjectFrame title="Billing FAQ">
      <div className="min-h-0 flex-1 p-2">
        <DatasetItemsTableExample />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DatasetItemsTableExample>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("row", { name: /open dataset row 1/i })
    )
    await expect(
      canvas.getByText("Selected dataset-item-storybook-invoice")
    ).toHaveTextContent("Selected dataset-item-storybook-invoice")
  },
}

export const Empty: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  render: () => (
    <StorybookProjectFrame title="Billing FAQ">
      <div className="min-h-0 flex-1 p-2">
        <DatasetItemsTableExample items={[]} />
      </div>
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(
        "No rows yet. Add a row or import your examples."
      )
    ).resolves.toBeVisible()
  },
}

export const MessageFieldViews: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  render: () => (
    <StorybookProjectFrame title="Mixed dataset values">
      <div className="min-h-0 flex-1 p-2">
        <DatasetItemsTableExample
          items={[
            {
              ...datasetItems[0],
              input: [{ role: "user", content: "A **bold** question" }],
            },
            datasetItems[1],
          ]}
        />
      </div>
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Input JSON" })
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: /^LLM$/ })
    )
    await expect(canvas.getByText("bold")).toHaveProperty("tagName", "STRONG")
    await expect(
      canvas.getByRole("row", { name: "Open dataset row 2" })
    ).toHaveTextContent("How do I change my payment method?")
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Input LLM" })
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "YAML" })
    )
    await expect(
      canvasElement.querySelector('[data-language="yaml"] .token.key')
    ).toHaveTextContent("role")
  },
}

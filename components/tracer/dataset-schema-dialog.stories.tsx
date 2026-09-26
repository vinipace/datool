import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import {
  datasetItems,
  datasetSchemas,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { DatasetSchemaDialog } from "./dataset-schema-dialog"

const saved = fn()

const meta = {
  title: "Tracer/Datasets/DatasetSchemaDialog",
  component: DatasetSchemaDialog,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DatasetSchemaDialog>

export default meta
type Story = StoryObj<typeof meta>

export const SchemaPreview: Story = {
  args: {
    onClose: fn(),
    onSave: async (schemas) => {
      saved(schemas)
    },
    sample: datasetItems[0],
    schemas: datasetSchemas,
  },
  play: async () => {
    const dialog = within(document.body)
    await expect(
      dialog.findByText("This example matches the schema.")
    ).resolves.toBeVisible()
    await expect(
      dialog.findByRole("tabpanel", { name: "Input" })
    ).resolves.toBeVisible()
    await userEvent.click(dialog.getByRole("tab", { name: "Expected" }))
    await expect(
      dialog.findByRole("tabpanel", { name: "Expected" })
    ).resolves.toBeVisible()
    await userEvent.click(dialog.getByRole("tab", { name: "Input" }))
    await userEvent.click(dialog.getByRole("button", { name: "Save schemas" }))
    await expect(saved).toHaveBeenCalledOnce()
  },
}

export const InvalidSchema: Story = {
  args: {
    onClose: fn(),
    onSave: async () => {},
    sample: datasetItems[0],
    schemas: {
      input: { enforced: false, schema: { type: "array" } },
    },
  },
  play: async () => {
    await expect(
      within(document.body).findByText(/Example validation:/)
    ).resolves.toBeVisible()
  },
}

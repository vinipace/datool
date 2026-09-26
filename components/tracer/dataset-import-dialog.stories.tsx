import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { DatasetImportDialog } from "./dataset-import-dialog"

const imported = fn()

const meta = {
  title: "Tracer/Datasets/DatasetImportDialog",
  component: DatasetImportDialog,
  args: { onClose: fn(), onImport: async () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DatasetImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const ValidImport: Story = {
  render: () => (
    <DatasetImportDialog
      onClose={fn()}
      onImport={async (items) => {
        imported(items)
      }}
    />
  ),
  play: async () => {
    const dialog = within(document.body)
    await userEvent.click(dialog.getByRole("button", { name: "Import rows" }))
    await expect(imported).toHaveBeenCalledOnce()
  },
}

export const ImportFailure: Story = {
  render: () => (
    <DatasetImportDialog
      onClose={fn()}
      onImport={async () => {
        throw new Error("One row does not match the enforced input schema.")
      }}
    />
  ),
  play: async () => {
    const dialog = within(document.body)
    await userEvent.click(dialog.getByRole("button", { name: "Import rows" }))
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "One row does not match the enforced input schema."
    )
  },
}

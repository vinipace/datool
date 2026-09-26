import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  datasetsEvalsHandlers,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  customField,
  evalRows,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import {
  ColumnEditor,
  ComputedColumnDetails,
  ComputedValue,
} from "./eval-computed-columns"

const fieldSaved = fn()

const meta = {
  title: "Tracer/Evals/ComputedColumns",
  component: ComputedValue,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ComputedValue>

export default meta
type Story = StoryObj<typeof meta>

export const ValueStates: Story = {
  render: () => (
    <StorybookProjectFrame title="Computed fields">
      <div className="grid gap-4 p-4 text-sm">
        <ComputedValue />
        <ComputedValue cell={{ value: null }} />
        <ComputedValue
          cell={{ error: "Could not read row.metrics.cost", value: null }}
        />
        <ComputedValue cell={{ value: "R$0.0142" }} />
        <ComputedValue
          format="markdown"
          cell={{ value: "**Grounded**\n\n- cites the invoice source" }}
        />
      </div>
    </StorybookProjectFrame>
  ),
}

export const EditorAndInspector: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/custom-fields", async ({ request }) => {
          const body = (await request.json()) as { field: ComputedColumn }
          await delay(150)
          return data(body.field)
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => (
    <StorybookProjectFrame title="Computed fields">
      <div className="grid gap-4 p-4">
        <ColumnEditor
          addedFields={[]}
          onSave={fieldSaved}
          resource="eval"
          rows={evalRows}
        />
        <ComputedColumnDetails
          action={
            <ColumnEditor
              addLabel="Add inspector field"
              addedFields={[customField]}
              borderless
              onSave={fieldSaved}
              rows={evalRows}
            />
          }
          cells={{
            [customField.id]: {
              [evalRows[0].id]: { value: "Where is my latest invoice?" },
            },
          }}
          columns={[customField]}
          onRemove={fn()}
          rowId={evalRows[0].id}
        />
      </div>
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    fieldSaved.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add Column" }))
    const dialog = within(document.body)
    await userEvent.click(
      await dialog.findByRole("button", { name: "Create new custom field" })
    )
    await expect(dialog.findByText("Add custom field")).resolves.toBeVisible()
    await userEvent.type(dialog.getByLabelText("Column name"), "Cost in BRL")
    await userEvent.click(dialog.getByRole("button", { name: "Add column" }))
    await waitFor(() => expect(fieldSaved).toHaveBeenCalledOnce())
    await expect(fieldSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Cost in BRL", mode: "template" })
    )
    await waitFor(() =>
      expect(
        dialog.queryByRole("dialog", { name: "Add custom field" })
      ).not.toBeInTheDocument()
    )
  },
}

export const EditorInRowDialog: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  render: () => (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Dataset row</DialogTitle>
        <DialogDescription>Edit fields for this row.</DialogDescription>
        <ColumnEditor
          addLabel="Add custom field"
          resource="dataset"
          rows={[]}
          onSave={fieldSaved}
        />
      </DialogContent>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    fieldSaved.mockClear()
    const page = within(canvasElement.ownerDocument.body)
    const row = within(await page.findByRole("dialog", { name: "Dataset row" }))
    const add = row.getByRole("combobox", { name: "Add custom field" })
    await userEvent.click(add)
    const search = await page.findByRole("combobox", { name: "Search custom fields" })
    await waitFor(() => expect(search).toHaveFocus())
    await userEvent.type(search, "Question")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(add).toHaveFocus())
    await expect(page.getByRole("dialog", { name: "Dataset row" })).toBeVisible()
    await userEvent.click(add)
    await userEvent.click(await page.findByRole("button", { name: "Create new custom field" }))
    const editor = within(await page.findByRole("dialog", { name: "Add custom field" }))
    const name = editor.getByRole("textbox", { name: "Column name" })
    await userEvent.type(name, "Mobile field")
    await expect(name).toHaveFocus()
    await expect(name).toHaveValue("Mobile field")
    await userEvent.click(editor.getByRole("button", { name: "Add column" }))
    await waitFor(() => expect(fieldSaved).toHaveBeenCalledOnce())
    await waitFor(() => expect(page.queryByRole("dialog", { name: "Add custom field" })).not.toBeInTheDocument())
    await expect(page.getByRole("dialog", { name: "Dataset row" })).toBeVisible()
    await waitFor(() => expect(add).toHaveFocus())
  },
}

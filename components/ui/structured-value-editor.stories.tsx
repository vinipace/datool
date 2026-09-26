import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  createTraceDocument,
  createTraceSchema,
} from "@/.storybook/scenarios/ui/fixtures"
import type { ValueDocument } from "@/src/lib/tracer/dataset-editor"
import { StructuredValueEditor } from "./structured-value-editor"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog"

function ValueEditor({
  document = createTraceDocument(),
  view,
}: {
  document?: ValueDocument
  view?: "json" | "yaml" | "text" | "pretty" | "tree"
}) {
  const [value, setValue] = React.useState<ValueDocument>(() => document)
  return (
    <div className="w-[42rem] max-w-full">
      <StructuredValueEditor
        height="h-64"
        label="Dataset metadata"
        schema={createTraceSchema()}
        value={value}
        view={view}
        onChange={setValue}
      />
    </div>
  )
}

const meta = {
  title: "UI/StructuredValueEditor",
  component: StructuredValueEditor,
  render: () => <ValueEditor />,
} satisfies Meta<typeof StructuredValueEditor>

export default meta
type Story = StoryObj<typeof ValueEditor>

export const EditableJson: Story = {}

export const TreePreview: Story = {
  render: () => <ValueEditor view="tree" />,
}

export const InvalidDraft: Story = {
  render: () => (
    <ValueEditor document={{ format: "json", text: "{ invalid" }} />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "Expected property name"
    )
  },
}

export const MessagePreviewInDialog: Story = {
  render: function MessageEditor() {
    const [document, setDocument] = React.useState<ValueDocument>({ format: "json", text: '[{"role":"assistant","content":"A **bold** answer"}]' })
    return <Dialog defaultOpen><DialogContent><DialogTitle>Dataset output</DialogTitle><DialogDescription>Preview formats preserve the saved value.</DialogDescription>
      <StructuredValueEditor label="Expected output" value={document} onChange={setDocument} />
      <output aria-label="Original draft">{document.text}</output>
    </DialogContent></Dialog>
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const picker = page.getByRole("combobox", { name: "Expected output format" })
    await userEvent.click(picker)
    await userEvent.click(await page.findByRole("option", { name: "LLM · read only" }))
    await expect(page.getByText("bold")).toHaveProperty("tagName", "STRONG")
    await expect(page.getByRole("button", { name: "Format Expected output" })).toBeDisabled()
    await expect(page.getByLabelText("Original draft")).toHaveTextContent('[{"role":"assistant","content":"A **bold** answer"}]')
    await userEvent.click(picker)
    await expect(page.findByRole("listbox")).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(page.getByRole("dialog")).toBeVisible()
    await waitFor(() =>
      expect(picker).toHaveFocus()
    )
  },
}

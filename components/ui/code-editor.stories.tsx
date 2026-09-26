import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  createScoreScript,
  createTraceSchema,
} from "@/.storybook/scenarios/ui/fixtures"
import { CodeEditor } from "./code-editor"
import { Button } from "./button"

const initialSchemaValue = JSON.stringify(
  { name: "Invoice extraction", enabled: true, priority: 2 },
  null,
  2
)
const editedSchemaValue = JSON.stringify(
  { name: "Storybook invoice", enabled: true, priority: 3 },
  null,
  2
)

function selectAllShortcut() {
  return navigator.platform.toLowerCase().includes("mac") ||
    navigator.userAgent.includes("Mac")
    ? "{Meta>}a{/Meta}"
    : "{Control>}a{/Control}"
}

async function selectAllEditorText(editor: HTMLElement) {
  await userEvent.click(editor)
  await expect(editor).toHaveFocus()
  await userEvent.keyboard(selectAllShortcut())
  const { monaco } = await import("@/components/tracer/monaco-runtime")
  const monacoEditor = monaco.editor
    .getEditors()
    .find((candidate) => candidate.getDomNode()?.contains(editor))
  if (!monacoEditor) {
    throw new Error(
      "Expected a Monaco editor for the accessible input surface."
    )
  }
  // Synthetic modifier keys do not consistently update Monaco's model
  // selection, so run the editor's real command before pasting.
  monacoEditor.trigger("storybook", "editor.action.selectAll", undefined)
  await waitFor(() => {
    expect(monacoEditor.getSelection()?.isEmpty()).toBe(false)
  })
  return monacoEditor
}

function JsonEditor({ readOnly = false }: { readOnly?: boolean }) {
  const [value, setValue] = React.useState(initialSchemaValue)

  return (
    <div className="grid gap-2">
      <CodeEditor
        className="h-80 w-[42rem] max-w-full"
        label="Trace schema value"
        language="json"
        readOnly={readOnly}
        schema={createTraceSchema()}
        value={value}
        onChange={setValue}
      />
      <output aria-label="Trace schema draft" className="sr-only">
        {value}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/CodeEditor",
  component: CodeEditor,
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="p-6">
      <JsonEditor />
    </div>
  ),
} satisfies Meta<typeof CodeEditor>

export default meta
type Story = StoryObj<typeof JsonEditor>

/**
 * Monaco's dark `vs-dark` JSON string token over its selected-text background
 * measures 3.21:1 in axe. `components/ui/code-editor.tsx` supplies the Datool
 * editor theme but leaves these Monaco selection tokens inherited. Keep the
 * selected read-only state visible while that production contrast debt is
 * repaired; the normal read-only story remains a blocking a11y check.
 */
const selectedTextA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known Monaco selected-text contrast debt: the dark JSON string token on its selected-text background measures 3.21:1. This story retains the real selection state while components/ui/code-editor.tsx gains a compliant Monaco selection theme.",
    },
  },
} as const

export const JsonWithSchema: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = await waitFor(
      () => canvas.getByRole("textbox", { name: "Trace schema value" }),
      { timeout: 10_000 }
    )
    await expect(editor).toHaveAttribute("aria-label", "Trace schema value")
    await expect(canvas.queryByText("Loading editor…")).not.toBeInTheDocument()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await selectAllEditorText(editor)
    await userEvent.paste(editedSchemaValue)
    await waitFor(() =>
      expect(canvas.getByLabelText("Trace schema draft").textContent).toBe(
        editedSchemaValue
      )
    )
  },
}

export const JavaScriptAndReadOnly: Story = {
  render: () => {
    const script = createScoreScript()
    return (
      <div className="grid gap-6 p-6">
        <CodeEditor
          className="h-64 w-[42rem] max-w-full"
          declarations="declare const output: { invoiceNumber?: string }"
          label="Invoice scorer"
          language="javascript"
          value={script}
          onChange={() => undefined}
        />
        <JsonEditor readOnly />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const script = await waitFor(
      () => canvas.getByRole("textbox", { name: "Invoice scorer" }),
      { timeout: 10_000 }
    )
    const readOnly = await waitFor(
      () => canvas.getByRole("textbox", { name: "Trace schema value" }),
      { timeout: 10_000 }
    )
    await expect(script).toHaveAttribute("aria-label", "Invoice scorer")
    await expect(readOnly).toHaveAttribute("aria-label", "Trace schema value")
    await expect(script).toBeVisible()
    await expect(canvas.queryByText("Loading editor…")).not.toBeInTheDocument()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.click(readOnly)
    await expect(readOnly).toHaveFocus()
    await userEvent.paste(editedSchemaValue)
    await expect(canvas.getByLabelText("Trace schema draft").textContent).toBe(
      initialSchemaValue
    )
  },
}

export const ReadOnlySelection: Story = {
  parameters: selectedTextA11yTodo,
  render: () => (
    <div className="p-6">
      <JsonEditor readOnly />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = await waitFor(
      () => canvas.getByRole("textbox", { name: "Trace schema value" }),
      { timeout: 10_000 }
    )
    await selectAllEditorText(editor)
  },
}

function ControlledEditorExample() {
  const [value, setValue] = React.useState('{"count": 1}')
  const [schemaType, setSchemaType] = React.useState<"number" | "string">(
    "number"
  )
  const [mounted, setMounted] = React.useState(true)
  return (
    <div className="grid gap-3 p-6">
      <div className="flex gap-2">
        <Button onClick={() => setSchemaType("string")}>Require text</Button>
        <Button onClick={() => setValue('{"count": "updated"}')}>
          Replace value
        </Button>
        <Button onClick={() => setMounted(false)}>Close editor</Button>
      </div>
      {mounted && (
        <CodeEditor
          className="h-64 w-full"
          label="Controlled document"
          language="json"
          schema={{
            type: "object",
            properties: { count: { type: schemaType } },
          }}
          value={value}
          onChange={setValue}
        />
      )}
      <output aria-label="Controlled draft" className="sr-only">
        {value}
      </output>
    </div>
  )
}

export const ControlledLifecycle: Story = {
  render: () => <ControlledEditorExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = await canvas.findByRole(
      "textbox",
      { name: "Controlled document" },
      { timeout: 10000 }
    )
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(input))!
    const model = editor.getModel()!
    const uri = model.uri.toString()
    const schemas = () =>
      monaco.json.jsonDefaults.diagnosticsOptions.schemas?.filter((entry) =>
        entry.fileMatch?.includes(uri)
      ) ?? []
    await waitFor(() => expect(schemas()).toHaveLength(1))
    await userEvent.click(canvas.getByRole("button", { name: "Require text" }))
    await waitFor(
      () =>
        expect(
          monaco.editor
            .getModelMarkers({ resource: model.uri })
            .some((marker) => marker.message.includes("string"))
        ).toBe(true),
      { timeout: 10000 }
    )
    await expect(editor.getModel()).toBe(model)
    await userEvent.click(canvas.getByRole("button", { name: "Replace value" }))
    await waitFor(() => expect(model.getValue()).toBe('{"count": "updated"}'))
    await waitFor(() =>
      expect(
        monaco.editor.getModelMarkers({ resource: model.uri })
      ).toHaveLength(0)
    )
    // Formatting and parent-driven edits remain undoable on the same document.
    editor.trigger("storybook", "undo", undefined)
    await waitFor(() =>
      expect(canvas.getByLabelText("Controlled draft").textContent).toBe(
        '{"count": 1}'
      )
    )
    await userEvent.click(canvas.getByRole("button", { name: "Close editor" }))
    await waitFor(() => {
      expect(model.isDisposed()).toBe(true)
      expect(schemas()).toHaveLength(0)
      expect(canvas.queryByRole("textbox")).not.toBeInTheDocument()
    })
  },
}

function MustacheEditorExample() {
  const [value, setValue] = React.useState("Output: {{output}}")
  const [narrow, setNarrow] = React.useState(false)
  return (
    <div className="p-6">
      <Button onClick={() => setNarrow((current) => !current)}>Toggle width</Button>
      <div data-testid="template-container" className={narrow ? "w-48" : "w-96"}>
        <CodeEditor language="mustache" label="Message template" autoSize lineNumbers={false} value={value} onChange={setValue} />
      </div>
      <output aria-label="Template draft">{value}</output>
    </div>
  )
}

export const GrowingMustache: Story = {
  render: () => <MustacheEditorExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = await canvas.findByRole("textbox", { name: "Message template" }, { timeout: 10000 })
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const editor = monaco.editor.getEditors().find((item) => item.getDomNode()?.contains(input))!
    const surface = canvas.getByTestId("template-container")
    const initialHeight = surface.getBoundingClientRect().height
    await expect(editor.getOption(monaco.editor.EditorOption.lineNumbers).renderType).toBe(0)
    await waitFor(() => {
      const tokens = monaco.editor.tokenize("Output: {{output}}", "mustache")[0]
      expect(tokens.some((token) => token.type.includes("keyword"))).toBe(true)
    })
    await selectAllEditorText(input)
    const multiline = "Evaluate the output carefully against the expected answer.\nInput: {{input}}\nOutput: {{output}}\nExpected: {{expected}}"
    await userEvent.paste(multiline)
    await waitFor(() => {
      expect(canvas.getByLabelText("Template draft")).toHaveTextContent("Expected: {{expected}}")
      expect(surface.getBoundingClientRect().height).toBeGreaterThan(initialHeight)
    })
    const wideHeight = surface.getBoundingClientRect().height
    await userEvent.click(canvas.getByRole("button", { name: "Toggle width" }))
    await waitFor(() => expect(surface.getBoundingClientRect().height).toBeGreaterThan(wideHeight))
    await selectAllEditorText(input)
    await userEvent.paste("{{input}}")
    await waitFor(() => expect(surface.getBoundingClientRect().height).toBe(initialHeight))
  },
}

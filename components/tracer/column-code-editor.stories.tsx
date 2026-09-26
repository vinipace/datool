import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { ComputedRow } from "@/src/lib/tracer/computed-columns"
import { traceRow } from "../../.storybook/scenarios/traces/fixtures"
import { ColumnCodeEditor } from "./column-code-editor"
import { Button } from "@/components/ui/button"

const rows: ComputedRow[] = [
  {
    datasetItemId: null,
    expectedOutput: null,
    id: "computed-row-storybook-001",
    results: [],
    trace: traceRow,
  },
]

function EditorExample() {
  const [value, setValue] = React.useState("row.metrics.cost ?? 0")
  return (
    <ColumnCodeEditor
      mode="expression"
      onChange={setValue}
      rows={rows}
      value={value}
    />
  )
}

function TemplateEditorExample() {
  const [value, setValue] = React.useState("Cost: {{ row.metrics.cost }}")
  return (
    <ColumnCodeEditor
      mode="template"
      onChange={setValue}
      rows={rows}
      value={value}
    />
  )
}

const meta = {
  title: "Tracer/ColumnCodeEditor",
  component: ColumnCodeEditor,
  render: () => <EditorExample />,
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        const editor = within(canvasElement).getByRole("textbox")
        const surface = editor.closest(".monaco-editor")
        expect(surface).not.toBeNull()
        expect(surface!.getBoundingClientRect().width).toBeGreaterThan(200)
      },
      { timeout: 10000 }
    )
  },
} satisfies Meta<typeof ColumnCodeEditor>

export default meta
type Story = StoryObj<typeof EditorExample>

export const ExpressionEditor: Story = {
  play: (context) => checkSuggestions(context.canvasElement, false),
}
export const TemplateEditor: Story = {
  render: () => <TemplateEditorExample />,
  play: (context) => checkSuggestions(context.canvasElement, true),
}

async function checkSuggestions(canvasElement: HTMLElement, template: boolean) {
  const canvas = within(canvasElement)
  const input = await canvas.findByRole("textbox", {}, { timeout: 10000 })
  expect(
    input.closest(".monaco-editor")!.getBoundingClientRect().width
  ).toBeGreaterThan(200)
  const { monaco } = await import("@/components/tracer/monaco-runtime")
  const editor = monaco.editor
    .getEditors()
    .find((item) => item.getDomNode()?.contains(input))!
  await userEvent.click(input)
  editor.trigger("storybook", "editor.action.selectAll", undefined)
  await userEvent.paste(template ? "Cost: {{ row.metrics." : "row.metrics.")
  await userEvent.click(canvas.getByRole("button", { name: "Suggestions" }))
  const suggestion = await canvas.findByRole(
    "option",
    { name: "cost, Field" },
    { timeout: 10000 }
  )
  await userEvent.dblClick(suggestion)
  await waitFor(() =>
    expect(editor.getValue()).toBe(
      template ? "Cost: {{ row.metrics.cost" : "row.metrics.cost"
    )
  )
  await userEvent.keyboard("{Escape}")
}

function ModeSwitchExample() {
  const [mode, setMode] = React.useState<"expression" | "template">(
    "expression"
  )
  const [mounted, setMounted] = React.useState(true)
  const [value, setValue] = React.useState("row.metrics.cost")
  return (
    <div className="grid gap-3">
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setMode("template")
            setValue("Cost: {{ row.metrics.cost }}")
          }}
        >
          Use template
        </Button>
        <Button onClick={() => setMounted(false)}>Close editor</Button>
      </div>
      {mounted && (
        <ColumnCodeEditor
          mode={mode}
          rows={rows}
          value={value}
          onChange={setValue}
        />
      )}
    </div>
  )
}

export const ModeSwitchAndCleanup: Story = {
  render: () => <ModeSwitchExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = await canvas.findByRole(
      "textbox",
      { name: "JavaScript expression code" },
      { timeout: 10000 }
    )
    const { monaco, typescript } =
      await import("@/components/tracer/monaco-runtime")
    const original = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(input))!
      .getModel()!
    const originalLib = original.uri.toString() + ".d.ts"
    await waitFor(() =>
      expect(
        typescript.javascriptDefaults.getExtraLibs()[originalLib]
      ).toBeDefined()
    )
    await userEvent.click(canvas.getByRole("button", { name: "Use template" }))
    const templateInput = await canvas.findByRole(
      "textbox",
      { name: "Template code" },
      { timeout: 10000 }
    )
    const model = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(templateInput))!
      .getModel()!
    const shadow = monaco.editor
      .getModels()
      .find(
        (item) =>
          item.uri.toString() === model.uri.toString() + "-expressions.js"
      )!
    await expect(original.isDisposed()).toBe(true)
    await expect(
      typescript.javascriptDefaults.getExtraLibs()[originalLib]
    ).toBeUndefined()
    await expect(model.getValue()).toBe("Cost: {{ row.metrics.cost }}")
    await expect(shadow.getValue()).toContain("row.metrics.cost")
    await userEvent.click(canvas.getByRole("button", { name: "Close editor" }))
    await waitFor(() => {
      expect(model.isDisposed()).toBe(true)
      expect(shadow.isDisposed()).toBe(true)
      expect(
        typescript.javascriptDefaults.getExtraLibs()[
          model.uri.toString() + ".d.ts"
        ]
      ).toBeUndefined()
    })
  },
}

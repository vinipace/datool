import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, waitFor, within } from "storybook/test"
import { ScorerCodeEditor } from "./scorer-code-editor"

function ScorerCodeEditorExample({
  language,
}: {
  language: "javascript" | "json"
}) {
  const [value, setValue] = useState(
    language === "javascript"
      ? "function evaluate({ trace }) {\n  return { score: trace.output ? 1 : 0 }\n}"
      : '{\n  "input": "What is 2 + 2?",\n  "expected": "4"\n}'
  )
  return (
    <ScorerCodeEditor
      className="h-80 w-[min(100%,48rem)]"
      label={language === "javascript" ? "Scorer code" : "Test sample JSON"}
      language={language}
      onChange={setValue}
      value={value}
    />
  )
}

const meta = {
  title: "Tracer/Scorers/ScorerCodeEditor",
  component: ScorerCodeEditor,
  args: {
    label: "Scorer code",
    language: "javascript",
    onChange: () => {},
    value: "function evaluate() { return { score: 1 } }",
  },
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
} satisfies Meta<typeof ScorerCodeEditor>

export default meta
type Story = StoryObj<typeof meta>

export const JavaScript: Story = {
  render: () => <ScorerCodeEditorExample language="javascript" />,
}

export const JsonSample: Story = {
  render: () => <ScorerCodeEditorExample language="json" />,
}

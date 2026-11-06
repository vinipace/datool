import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { newJourneyInput } from "@/src/lib/build/agent-journey"
import { AgentJourneyEditor } from "./agent-journey-editor"
import { JourneyResults } from "./journey-results"

const meta = {
  title: "Build/Agents/Customer journeys",
  component: AgentJourneyEditor,
  args: { input: newJourneyInput(), onChange: fn() },
  render: function Example(args) {
    const [input, setInput] = useState(args.input)
    return (
      <div className="w-96 max-w-full">
        <AgentJourneyEditor
          {...args}
          input={input}
          onChange={(value) => {
            setInput(value)
            args.onChange(value)
          }}
        />
      </div>
    )
  },
} satisfies Meta<typeof AgentJourneyEditor>
export default meta
type Story = StoryObj<typeof meta>

export const AuthorJourney: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Customer message"),
      "Quero uma roupa personalizada"
    )
    await expect(
      canvas.getByText("Test code").closest("details")
    ).not.toHaveAttribute("open")
    await userEvent.click(canvas.getByText("Test code"))
    const editor = await canvas.findByRole(
      "textbox",
      { name: "Test code" },
      { timeout: 10_000 }
    )
    await userEvent.click(editor)
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const codeEditor = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.contains(editor))
    if (!codeEditor) throw new Error("The test code editor did not load.")
    if (codeEditor.getModel()?.getValue()) {
      codeEditor.trigger("storybook", "editor.action.selectAll", undefined)
      await waitFor(() =>
        expect(codeEditor.getSelection()?.isEmpty()).toBe(false)
      )
    }
    await userEvent.paste(
      'await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();'
    )
    await userEvent.click(canvas.getByText("Options"))
    await userEvent.selectOptions(
      canvas.getByLabelText("Test preview width"),
      "768"
    )
    await userEvent.clear(canvas.getByLabelText("Test language"))
    await userEvent.type(canvas.getByLabelText("Test language"), "pt-BR")
    await userEvent.click(canvas.getByLabelText("Required for publishing"))
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Quero uma roupa personalizada",
        channel: "web",
        journey: expect.objectContaining({
          required: false,
          width: 768,
          locale: "pt-BR",
          code: 'await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();',
        }),
      })
    )
    await waitFor(() =>
      expect(canvas.queryByRole("status")).not.toBeInTheDocument()
    )
  },
}

export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Customer message")).toBeDisabled()
    await expect(canvas.getByLabelText("Test name")).toBeDisabled()
  },
}

export const FailedInteraction: Story = {
  render: () => (
    <div className="w-96 max-w-full">
      <JourneyResults
        result={{
          name: "Personalizar roupa",
          status: "failed",
          fingerprint: "storybook",
          agentRevision: 7,
          width: 390,
          error: "Continuar was not available.",
          steps: [
            { name: "Select two models", status: "passed", error: null },
            {
              name: "Click Continuar",
              status: "failed",
              error: "Continuar was not available.",
            },
            { name: "Check handoff message", status: "skipped", error: null },
          ],
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Interactions failed")).toBeVisible()
    await expect(canvas.getByText("Continuar was not available.")).toBeVisible()
    await expect(canvas.getByText("skipped")).toBeVisible()
  },
}

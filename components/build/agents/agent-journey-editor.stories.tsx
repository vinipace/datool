import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
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
      canvas.getByLabelText("First customer message"),
      "Quero uma roupa personalizada"
    )
    await userEvent.type(
      canvas.getByLabelText("Step 1 expected text"),
      "Escolha os modelos"
    )
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Add step" }))
    await userEvent.selectOptions(canvas.getByLabelText("Step 2 type"), "fill")
    await userEvent.type(
      canvas.getByLabelText("Step 2 button or field label"),
      "Data do evento"
    )
    await userEvent.type(canvas.getByLabelText("Step 2 value"), "2030-12-30")
    await userEvent.selectOptions(
      canvas.getByLabelText("Journey preview width"),
      "768"
    )
    await userEvent.clear(canvas.getByLabelText("Journey language"))
    await userEvent.type(canvas.getByLabelText("Journey language"), "pt-BR")
    await userEvent.click(canvas.getByLabelText("Required for publishing"))
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Quero uma roupa personalizada",
        channel: "web",
        journey: expect.objectContaining({
          required: false,
          width: 768,
          locale: "pt-BR",
          steps: [
            { type: "expect_text", text: "Escolha os modelos" },
            { type: "fill", name: "Data do evento", value: "2030-12-30" },
          ],
        }),
      })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Remove step 1" }))
    await expect(canvas.getByLabelText("Step 1 value")).toHaveValue(
      "2030-12-30"
    )
  },
}

export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("First customer message")).toBeDisabled()
    await expect(
      canvas.getByRole("button", { name: "Add step" })
    ).toBeDisabled()
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

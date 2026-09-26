import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { expect, fn, userEvent, within } from "storybook/test"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  datasetsEvalsHandlers,
  failure,
  data,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  comparisonRun,
  evalRun,
  list,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { EvalComparePicker } from "./eval-compare-picker"

const changed = fn()
function Picker(props: React.ComponentProps<typeof EvalComparePicker>) {
  const [ids, setIds] = useState(props.selectedIds)
  return (
    <EvalComparePicker
      {...props}
      selectedIds={ids}
      onChange={(next) => {
        setIds(next)
        props.onChange(next)
      }}
    />
  )
}
const meta = {
  title: "Tracer/Evals/EvalComparePicker",
  component: EvalComparePicker,
  args: {
    baseline: evalRun,
    selectedRuns: [],
    selectedIds: [],
    onChange: changed,
  },
  beforeEach: () => {
    changed.mockClear()
  },
  render: (args) => (
    <StorybookProjectFrame title="Compare runs">
      <div className="w-80 p-3">
        <Picker {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof EvalComparePicker>
export default meta
type Story = StoryObj<typeof meta>

export const AvailableRuns: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("combobox", { name: "Comparison runs" })
    )
    const candidate = await body.findByRole("option", { name: /candidate/ })
    await userEvent.click(candidate)
    await expect(changed).toHaveBeenLastCalledWith([comparisonRun.id])
    await expect(
      body.getByRole("option", { name: /baseline/ })
    ).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(candidate)
    await expect(changed).toHaveBeenLastCalledWith([])
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.getByRole("combobox", { name: "Comparison runs" })
    ).toHaveFocus()
  },
}
export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evals", () => failure("Could not load comparison runs")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Could not load comparison runs")
    ).resolves.toBeVisible()
  },
}

const extraRuns = [3, 4, 5].map(index => ({ ...comparisonRun, id: `run-${index}`, name: `Candidate ${index}` }))
export const FourRunLimit: Story = {
  args: { selectedIds: [comparisonRun.id, "run-3", "run-4"], selectedRuns: [comparisonRun, ...extraRuns] },
  parameters: { msw: { handlers: [http.get("/api/evals", () => data(list([evalRun, comparisonRun, ...extraRuns])))] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(await canvas.findByRole("combobox", { name: "Comparison runs" }))
    await expect(await body.findByRole("option", { name: /Candidate 5/ })).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(body.getByRole("option", { name: /Candidate 4/ }))
    await expect(body.getByRole("option", { name: /Candidate 5/ })).not.toHaveAttribute("aria-disabled", "true")
    await userEvent.click(body.getByRole("option", { name: /Candidate 5/ }))
    await expect(changed).toHaveBeenLastCalledWith([comparisonRun.id, "run-3", "run-5"])
    await userEvent.keyboard("{Escape}")
  },
}
export const EmptyRuns: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/evals", () => data(list([])))] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("combobox", { name: "Comparison runs" })
    )
    await userEvent.type(
      await body.findByRole("combobox", { name: /Search/i }),
      "not a run"
    )
    await expect(
      body.findByText("No matching eval runs")
    ).resolves.toBeVisible()
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { evalRun } from "../../.storybook/scenarios/datasets-evals/fixtures"
import type { EvalScorerProgress } from "@/src/lib/tracer/contracts"
import { EvalRunProgress } from "./eval-run-progress"

const progress: EvalScorerProgress = {
  evaluatorId: evalRun.evaluatorIds[0],
  name: "Sample quality",
  version: 1,
  total: 4,
  completed: 4,
  error: 0,
  skipped: 0,
  queued: 0,
  running: 0,
  score: 0.9,
}
const completed = {
  ...evalRun,
  targetCount: 4,
  resultCount: 4,
  scorerProgress: [progress],
  execution: {
    workerOnline: false,
    stalled: false,
    lastProgressAt: evalRun.completedAt,
    stages: { completed: 4 },
  },
}

const meta = {
  title: "Tracer/Evals/EvalRunProgress",
  component: EvalRunProgress,
  args: { run: completed },
  decorators: [
    (Story) => (
      <div className="w-56 max-w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EvalRunProgress>
export default meta
type Story = StoryObj<typeof meta>

export const Completed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("button", {
      name: /Scoring progress details/,
    })
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "4 of 4 finished"
    )
    await expect(trigger.textContent).toBe("")
    await expect(trigger.getBoundingClientRect().height).toBe(16)
    await expect(trigger.getBoundingClientRect().width).toBe(40)
    await expect(canvas.getByRole("progressbar").getBoundingClientRect().width).toBe(40)
    await userEvent.tab()
    await expect(trigger).toHaveFocus()
    await expect(body.findByText("Finished scorer runs")).resolves.toBeVisible()
    const donut = body.getByRole("progressbar", { name: "Scoring completion" })
    await expect(donut).toHaveTextContent("100%")
    await expect(donut).toHaveAttribute("aria-valuetext", "100% finished (4 of 4)")
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false")
    )
    await userEvent.tab()
    await userEvent.hover(trigger)
    await expect(body.findByText("Finished scorer runs")).resolves.toBeVisible()
    await expect(body.getByText("4 targets · 1 scorer")).toBeVisible()
    await userEvent.unhover(trigger)
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(body.queryByText("Finished scorer runs")).not.toBeInTheDocument()
    )
  },
}

export const Running: Story = {
  args: {
    run: {
      ...completed,
      status: "running",
      completedAt: null,
      resultCount: 1,
      scorerProgress: [{ ...progress, completed: 1, running: 1, queued: 2 }],
      execution: {
        ...completed.execution,
        workerOnline: true,
        stages: { completed: 1, scoring: 3 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "1"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      body.findByText("Queued", { exact: true })
    ).resolves.toBeVisible()
    const donut = body.getByRole("progressbar", { name: "Scoring completion" })
    await expect(donut).toHaveTextContent("25%")
    await expect(donut).toHaveAttribute("aria-valuetext", "25% finished (1 of 4)")
  },
}

export const ErrorsAndSkipped: Story = {
  args: {
    run: {
      ...completed,
      status: "partial",
      scorerProgress: [{ ...progress, completed: 2, error: 1, skipped: 1 }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "4"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    const body = within(canvasElement.ownerDocument.body)
    await expect(body.findByText("Partial")).resolves.toBeVisible()
    await expect(
      body.findByText("Errors", { exact: true })
    ).resolves.toBeVisible()
    await expect(body.getByText("Skipped", { exact: true })).toBeVisible()
  },
}

export const Stalled: Story = {
  args: {
    run: {
      ...completed,
      status: "running",
      completedAt: null,
      resultCount: 0,
      scorerProgress: [{ ...progress, completed: 0, queued: 4 }],
      execution: {
        ...completed.execution,
        stalled: true,
        stages: { awaiting_delivery: 4 },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    const body = within(canvasElement.ownerDocument.body)
    await expect(body.findByText(/Progress has stalled/)).resolves.toBeVisible()
  },
}

export const NoScorers: Story = {
  args: {
    run: {
      ...completed,
      targetCount: 4,
      evaluatorIds: [],
      resultCount: 0,
      scorerProgress: [],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "No scorer runs"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByText(
        "This run has no scorer executions."
      )
    ).resolves.toBeVisible()
    const donut = within(canvasElement.ownerDocument.body).getByRole("progressbar", { name: "Scoring completion" })
    await expect(donut).toHaveTextContent("0%")
    await expect(donut).toHaveAttribute("aria-valuetext", "No scorer runs")
  },
}

export const MissingProgress: Story = {
  args: {
    run: {
      ...completed,
      status: "cancelled",
      resultCount: 1,
      scorerProgress: undefined,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "1 of 4 finished"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    const body = within(canvasElement.ownerDocument.body)
    await expect(body.findByText("Cancelled")).resolves.toBeVisible()
    await expect(body.getByText("Pending")).toBeVisible()
  },
}

export const Failed: Story = {
  args: {
    run: {
      ...completed,
      status: "failed",
      resultCount: 0,
      scorerProgress: [{ ...progress, completed: 0, queued: 4 }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /Scoring progress details/ })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByText("Failed")
    ).resolves.toBeVisible()
  },
}

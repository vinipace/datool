import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within, screen } from "storybook/test"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import { evalRun } from "../../.storybook/scenarios/datasets-evals/fixtures"
import { EvalRunActions } from "./eval-run-actions"

const created = fn()

const meta = {
  title: "Tracer/Evals/EvalRunActions",
  component: EvalRunActions,
  render: (args) => (
    <StorybookProjectFrame title="Billing FAQ baseline">
      <EvalRunActions {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof EvalRunActions>

export default meta
type Story = StoryObj<typeof meta>

export const CompletedRun: Story = {
  args: { run: evalRun },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/evals", async ({ request }) => {
          created(await request.json())
          return data(evalRun)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Re-score saved traces",
      })
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Re-score outputs" })
    )
    await waitFor(() => expect(created).toHaveBeenCalledOnce())
    await expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRunId: evalRun.id, background: true })
    )
  },
}

export const RunAppAgain: Story = {
  ...CompletedRun,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run app again" })
    )
    await userEvent.click(screen.getByRole("button", { name: "Run app" }))
    await waitFor(() => expect(created).toHaveBeenCalledOnce())
    await expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: evalRun.id,
        useRecordedVersions: false,
        background: true,
      })
    )
    await expect(created.mock.calls[0][0]).not.toHaveProperty("sourceRunId")
  },
}

export const RescoreFailure: Story = {
  args: { run: evalRun },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/evals", () =>
          failure("The saved traces are no longer available")
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Re-score saved traces",
      })
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Re-score outputs" })
    )
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "The saved traces are no longer available"
    )
  },
}

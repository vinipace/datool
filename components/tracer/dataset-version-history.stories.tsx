import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { http } from "msw"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  list,
  storybookDatasetId,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { DatasetVersionHistory } from "./dataset-version-history"

const meta = {
  title: "Tracer/Datasets/DatasetVersionHistory",
  component: DatasetVersionHistory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DatasetVersionHistory>

export default meta
type Story = StoryObj<typeof meta>

export const Changes: Story = {
  args: { datasetId: storybookDatasetId, onClose: fn() },
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async () => {
    const dialog = within(document.body)
    await expect(dialog.findByText("Row updated")).resolves.toBeVisible()
    await userEvent.click(dialog.getByText("Dataset settings updated"))
    await expect(
      dialog.findByText("Dataset details and schemas")
    ).resolves.toBeVisible()
    const changes = dialog.getByRole("region", { name: "Version changes" })
    dialog.getByRole("button", { name: /Dataset settings updated/ }).focus()
    await userEvent.tab()
    await expect(changes).toHaveFocus()
  },
}

export const Empty: Story = {
  args: { datasetId: storybookDatasetId, onClose: fn() },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets/:datasetId/versions", () => data(list([]))),
      ],
    },
  },
  play: async () => {
    await expect(
      within(document.body).findByText(
        "No changes recorded yet. Edits will appear here automatically."
      )
    ).resolves.toBeVisible()
  },
}

export const LoadFailure: Story = {
  args: { datasetId: storybookDatasetId, onClose: fn() },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets/:datasetId/versions", () =>
          failure("Could not load version history")
        ),
      ],
    },
  },
  play: async () => {
    await expect(
      within(document.body).findByText("Could not load version history")
    ).resolves.toBeVisible()
  },
}

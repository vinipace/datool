import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { datasetsEvalsHandlers } from "../../.storybook/scenarios/datasets-evals/handlers"
import { dataset } from "../../.storybook/scenarios/datasets-evals/fixtures"
import { DatasetDetailsInspector } from "./dataset-details-inspector"

const saved = fn()

const meta = {
  title: "Tracer/Datasets/DatasetDetailsInspector",
  component: DatasetDetailsInspector,
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/datasets" } },
  },
  render: (args) => (
    <StorybookProjectFrame title="Billing FAQ">
      <div className="min-h-0 flex-1">
        <DatasetDetailsInspector {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DatasetDetailsInspector>

export default meta
type Story = StoryObj<typeof meta>

export const DetailsAndSave: Story = {
  args: {
    dataset,
    onClose: fn(),
    onSave: async (patch) => {
      saved(patch)
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.clear(canvas.getByLabelText("Dataset description"))
    await userEvent.type(
      canvas.getByLabelText("Dataset description"),
      "Release-ready examples for billing support."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save details" }))
    await expect(saved).toHaveBeenCalledOnce()
  },
}

export const RecentlyUsedRuns: Story = {
  args: { dataset, onClose: fn(), onSave: async () => {} },
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /recently used in/i })
    )
    await expect(
      canvas.findByText("Evaluation runs using this dataset")
    ).resolves.toBeVisible()
  },
}

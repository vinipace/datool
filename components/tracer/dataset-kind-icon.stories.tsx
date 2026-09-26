import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { DatasetKindIcon } from "./dataset-kind-icon"

const meta = {
  title: "Tracer/Datasets/DatasetKindIcon",
  component: DatasetKindIcon,
  args: { kind: "dataset" },
} satisfies Meta<typeof DatasetKindIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-5 text-foreground">
      <span className="flex items-center gap-2">
        <DatasetKindIcon kind="dataset" aria-hidden="true" /> Dataset
      </span>
      <span className="flex items-center gap-2">
        <DatasetKindIcon kind="folder" aria-hidden="true" /> Folder
      </span>
      <span className="flex items-center gap-2">
        <DatasetKindIcon kind="folder" expanded aria-hidden="true" /> Open
        folder
      </span>
    </div>
  ),
}

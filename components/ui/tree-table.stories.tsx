import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { TreeAddButton, TreeIndent, treeTable } from "./tree-table"

function DatasetTreeRow() {
  const [added, setAdded] = React.useState(0)
  return (
    <div className={`w-96 rounded-md border border-border ${treeTable.row}`}>
      <TreeIndent depth={2}>
        <TreeAddButton
          label="Add nested dataset"
          onClick={() => setAdded((count) => count + 1)}
        />
      </TreeIndent>
      <output className="block border-t border-border px-3 py-2 text-xs text-foreground-muted">
        Nested datasets added: {added}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/TreeTable",
  component: TreeIndent,
  render: () => <DatasetTreeRow />,
} satisfies Meta<typeof TreeIndent>

export default meta
type Story = StoryObj<typeof DatasetTreeRow>

export const AddNestedRow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Add nested dataset" })
    )
    await expect(canvas.getByText("Nested datasets added: 1")).toBeVisible()
  },
}

import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { HeaderDisplay } from "./collection-header"
import { TableViewControls } from "./table-view-controls"

function TableViewControlsExample() {
  const [view, setView] = React.useState<"table" | "cards">("table")
  const [rowHeight, setRowHeight] = React.useState<"compact" | "tall">("compact")
  const [columns, setColumns] = React.useState([
    { id: "name", label: "Name", visible: true },
    { id: "output", label: "Output", visible: true },
  ])

  return (
    <StorybookProjectFrame title="Trace collection">
      <TableViewControls>
        <HeaderDisplay
          columns={columns}
          onChange={(id, visible) =>
            setColumns((current) =>
              current.map((column) =>
                column.id === id ? { ...column, visible } : column
              )
            )
          }
          view={view}
          onViewChange={setView}
          rowHeight={rowHeight}
          onRowHeightChange={setRowHeight}
        />
        <div className="p-4 text-sm text-foreground-muted">
          Current columns:{" "}
          {columns
            .filter((column) => column.visible)
            .map((column) => column.label)
            .join(", ")}
        </div>
      </TableViewControls>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/TableViewControls",
  component: TableViewControls,
  parameters: { layout: "fullscreen" },
  render: () => <TableViewControlsExample />,
} satisfies Meta<typeof TableViewControls>

export default meta
type Story = StoryObj<typeof TableViewControlsExample>

const openMenuA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Open-menu axe finding in Storybook portal composition: keyboard focus on the Display trigger leaves a focusable target in the hidden project frame portal host. Production impact is not separately verified.",
    },
  },
} as const

export const HeaderGrouping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Display" })
    )
    await expect(
      body.getByRole("menuitemcheckbox", { name: "Output" })
    ).toBeVisible()
    await userEvent.click(
      body.getByRole("menuitemcheckbox", { name: "Output" })
    )
    await expect(
      canvas.findByText("Current columns: Name")
    ).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}

export const OpenDisplayMenu: Story = {
  parameters: openMenuA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const display = await canvas.findByRole("button", { name: "Display" })
    display.focus()
    await userEvent.keyboard("{Enter}")
    await expect(
      body.findByRole("menuitemcheckbox", { name: "Output" })
    ).resolves.toBeVisible()
  },
}

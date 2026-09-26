import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  CollectionHeaderControls,
  HeaderDisplay,
  HeaderSlot,
} from "./collection-header"

const onRefresh = fn()
const onChange = fn()

function HeaderExample() {
  return (
    <StorybookProjectFrame title="Trace collection">
      <CollectionHeaderControls
        exportName="traces"
        exportRows={[{ id: "trace-storybook-001", name: "Invoice question" }]}
        onRefresh={onRefresh}
      >
        <label className="text-sm text-foreground-muted" htmlFor="trace-search">
          Search
          <input
            className="ml-2 rounded border border-input bg-background px-2 py-1 text-sm"
            id="trace-search"
            placeholder="Filter traces"
          />
        </label>
      </CollectionHeaderControls>
      <HeaderDisplay
        columns={[
          { id: "name", label: "Name", visible: true },
          { id: "input", label: "Input", visible: false },
        ]}
        onChange={onChange}
        rowHeight="compact"
        onRowHeightChange={fn()}
      />
      <HeaderSlot name="menu">
        <span className="text-xs text-foreground-muted">Portal content</span>
      </HeaderSlot>
      <p className="p-4 text-sm text-foreground-muted">
        Header controls render into the project frame above this content.
      </p>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/CollectionHeader",
  component: CollectionHeaderControls,
  parameters: { layout: "fullscreen" },
  render: () => <HeaderExample />,
} satisfies Meta<typeof CollectionHeaderControls>

export default meta
type Story = StoryObj<typeof HeaderExample>

const openMenuA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Open-menu axe finding in Storybook portal composition: keyboard focus on the Display trigger leaves a focusable target in the hidden project frame portal host. Production impact is not separately verified.",
    },
  },
} as const

export const PortalControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Display" })
    )
    await expect(body.findByText("Visible columns")).resolves.toBeVisible()
    await userEvent.click(body.getByRole("menuitemcheckbox", { name: "Input" }))
    await expect(onChange).toHaveBeenCalledWith("input", true)
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
    await expect(body.findByText("Visible columns")).resolves.toBeVisible()
  },
}

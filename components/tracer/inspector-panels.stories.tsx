import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Button } from "@/components/ui/button"
import { InspectorPanelContext } from "./inspector-panel-context"
import { InspectorPanels } from "./inspector-panels"

function InspectorPanelExample() {
  const panel = React.useContext(InspectorPanelContext)
  return (
    <div className="p-4">
      <Button
        onClick={() => panel?.setOpen((open) => !open)}
        size="sm"
        variant="outline"
      >
        {panel?.open ? "Close inspector" : "Open inspector"}
      </Button>
      <p className="mt-4 text-sm text-foreground-muted">
        The workspace panel keeps scrollable content beside an optional
        inspector dock.
      </p>
      {panel?.target ? (
        <p className="p-4 text-sm">Inspector target is ready.</p>
      ) : null}
    </div>
  )
}

const meta = {
  title: "Tracer/InspectorPanels",
  component: InspectorPanels,
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="flex h-[720px] flex-col"><InspectorPanels>
      <InspectorPanelExample />
    </InspectorPanels></div>
  ),
} satisfies Meta<typeof InspectorPanels>

export default meta
type Story = StoryObj<typeof meta>

export const ToggleDock: Story = {}

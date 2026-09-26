import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Button } from "@/components/ui/button"
import { DockedInspector } from "./docked-inspector"

function DockedInspectorExample() {
  const [open, setOpen] = React.useState(true)
  return (
    <DockedInspector
      mobileOpen={open}
      onMobileClose={() => setOpen(false)}
      title="Trace details"
    >
      <div className="p-4">
        <h2 className="text-sm font-semibold">Trace details</h2>
        <p className="mt-2 text-sm text-foreground-muted">
          A responsive inspector uses a dock at desktop widths and a
          focus-contained sheet on narrow screens.
        </p>
        <Button
          className="mt-4"
          onClick={() => setOpen(false)}
          size="sm"
          variant="outline"
        >
          Close details
        </Button>
      </div>
    </DockedInspector>
  )
}

const meta = {
  title: "Tracer/DockedInspector",
  component: DockedInspector,
  render: () => <DockedInspectorExample />,
} satisfies Meta<typeof DockedInspector>

export default meta
type Story = StoryObj<typeof DockedInspectorExample>

export const DesktopDock: Story = {}

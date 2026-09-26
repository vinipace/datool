import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, within } from "storybook/test"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./resizable"

const meta = {
  title: "UI/Resizable",
  component: ResizablePanelGroup,
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="h-72 p-6">
      <ResizablePanelGroup id="storybook-inspector" orientation="horizontal">
        <ResizablePanel defaultSize="42%" id="trace-list" minSize="25%">
          <section className="h-full rounded-l-lg bg-muted p-4">
            <h2 className="font-medium">Trace list</h2>
            <p className="mt-2 text-sm text-foreground-muted">
              18 captured traces
            </p>
          </section>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize inspector" withHandle />
        <ResizablePanel defaultSize="58%" id="trace-detail" minSize="25%">
          <section className="h-full rounded-r-lg border-l border-border bg-background p-4">
            <h2 className="font-medium">Trace detail</h2>
            <p className="mt-2 text-sm text-foreground-muted">
              Invoice extraction
            </p>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
} satisfies Meta<typeof ResizablePanelGroup>

export default meta
type Story = StoryObj<typeof meta>

export const InspectorLayout: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByLabelText("Resize inspector")
    ).toHaveAttribute("data-slot", "resizable-handle")
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { renderToString } from "react-dom/server"
import { expect, within } from "storybook/test"
import { InspectorPanels } from "@/components/tracer/inspector-panels"
import { LoadingState, PageLoading } from "./loading-state"
import { StorybookProjectFrame } from "../../.storybook/component-frame"

const meta = {
  title: "UI/LoadingState",
  component: LoadingState,
  render: () => (
    <div className="grid w-[34rem] max-w-full gap-4">
      <LoadingState label="Loading trace summary" />
      <PageLoading />
    </div>
  ),
} satisfies Meta<typeof LoadingState>

export default meta
type Story = StoryObj<typeof meta>

export const PageFallback: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <StorybookProjectFrame title="Workflows">
      <InspectorPanels>
        <PageLoading />
      </InspectorPanels>
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const loading = canvas.getByRole("status")
    await expect(loading).toHaveTextContent("Loading page")
    await expect(loading.getBoundingClientRect().height).toBeGreaterThan(300)
    await expect(within(loading).queryByRole("button")).not.toBeInTheDocument()
    const toolbar = canvasElement.querySelector(
      '[data-slot="collection-toolbar-skeleton"]'
    )!
    await expect(toolbar.getBoundingClientRect().height).toBe(53)
    await expect(toolbar.getBoundingClientRect().width).toBe(
      canvasElement
        .querySelector('[data-slot="resizable-panel-group"]')!
        .getBoundingClientRect().width
    )
    await expect(toolbar.getBoundingClientRect().top).toBe(
      canvas
        .getByRole("banner", { name: "Page controls" })
        .getBoundingClientRect().bottom
    )
  },
}

// Keep the server HTML unhydrated to catch sizing that client effects would hide.
export const ServerRenderedPageFallback: Story = {
  ...PageFallback,
  render: () => (
    <StorybookProjectFrame title="Evals">
      <div
        className="h-full min-h-0 w-full"
        dangerouslySetInnerHTML={{
          __html: renderToString(
            <InspectorPanels>
              <PageLoading />
            </InspectorPanels>
          ),
        }}
      />
    </StorybookProjectFrame>
  ),
}

export const NarrowPageFallback: Story = {
  ...PageFallback,
  render: () => (
    <div className="w-[300px] max-w-full">
      <StorybookProjectFrame title="Workflows">
        <InspectorPanels>
          <PageLoading />
        </InspectorPanels>
      </StorybookProjectFrame>
    </div>
  ),
  play: async (context) => {
    await PageFallback.play?.(context)
    const toolbar = context.canvasElement.querySelector<HTMLElement>(
      '[data-slot="collection-toolbar-skeleton"]'
    )!
    await expect(toolbar.scrollWidth).toBe(toolbar.clientWidth)
    await expect(
      toolbar
        .querySelector('[data-slot="collection-display-skeleton"]')!
        .getBoundingClientRect().width
    ).toBe(40)
    const loading = within(context.canvasElement).getByRole("status")
    await expect(loading.getBoundingClientRect().width).toBe(276)
    const panel = loading.parentElement!.parentElement!
    await expect(panel.scrollWidth).toBe(panel.clientWidth)
    await expect(panel.scrollHeight).toBe(panel.clientHeight)
  },
}

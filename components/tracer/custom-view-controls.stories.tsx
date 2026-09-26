import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  customViewHandlers,
  storybookCustomView,
  storybookViewSettings,
} from "../../.storybook/scenarios/traces/views"
import { Button } from "@/components/ui/button"
import { CustomViewControls } from "./custom-view-controls"

function CustomViewControlsExample({ initialViewId = null }: { initialViewId?: string | null }) {
  const [settings, setSettings] = React.useState(storybookViewSettings)
  const [viewId, setViewId] = React.useState<string | null>(initialViewId)
  return (
    <StorybookProjectFrame title="Evaluation runs">
      <CustomViewControls
        onApply={setSettings}
        onSelect={setViewId}
        settings={settings}
        viewId={viewId}
      />
      {initialViewId && <Button onClick={() => setViewId(null)}>Clear selected view</Button>}
      <p className="p-4 text-sm text-foreground-muted">
        Current layout: {settings.view}; selected view: {viewId ?? "none"}
      </p>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/CustomViewControls",
  component: CustomViewControls,
  parameters: { layout: "fullscreen", msw: { handlers: customViewHandlers } },
  render: () => <CustomViewControlsExample />,
} satisfies Meta<typeof CustomViewControls>

export default meta
type Story = StoryObj<typeof CustomViewControlsExample>

export const SavedLayouts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("combobox", { name: "Custom view" })
    )
    await expect(body.findByText("Review layout")).resolves.toBeVisible()
    await expect(
      body.getByRole("button", { name: /Create new view with changes/ })
    ).toBeVisible()
  },
}

export const LoadAndClear: Story = {
  render: () => <CustomViewControlsExample initialViewId={storybookCustomView.id} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByRole("combobox", { name: "Custom view" })).toHaveTextContent("Review layout"))
    await expect(canvas.queryByText("Loading saved view…")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Clear selected view" }))
    await waitFor(() => expect(canvas.getByRole("combobox", { name: "Custom view" })).toHaveTextContent("Unsaved view"))
    await expect(canvas.queryByText("Loading saved view…")).not.toBeInTheDocument()
  },
}

import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { InspectorPanels } from "./inspector-panels"
import { traceDetail } from "../../.storybook/scenarios/traces/fixtures"
import { TraceInspectorOverlay } from "./trace-list-overlay"
import { Button } from "@/components/ui/button"

function OverlayExample() {
  const [open, setOpen] = React.useState(true)
  const returnFocusRef = React.useRef<HTMLInputElement>(null)
  return (
    <InspectorPanels>
      <div className="p-4 text-sm text-foreground-muted">
        Trace list workspace
        <input ref={returnFocusRef} aria-label="Preserved list state" defaultValue="Keep this filter" />
      </div>
      {open ? (
        <TraceInspectorOverlay
          onClose={() => setOpen(false)}
          returnFocusRef={returnFocusRef}
          snapshot={traceDetail}
          traceId={traceDetail.id}
        />
      ) : (
        <div className="p-4 text-sm">
          <p>Inspector closed</p>
          <Button onClick={() => setOpen(true)}>Open trace</Button>
        </div>
      )}
    </InspectorPanels>
  )
}

const meta = {
  title: "Tracer/TraceInspectorOverlay",
  component: TraceInspectorOverlay,
  parameters: { layout: "fullscreen" },
  render: () => <div className="flex h-[640px] flex-col"><OverlayExample /></div>,
} satisfies Meta<typeof TraceInspectorOverlay>

export default meta
type Story = StoryObj<typeof OverlayExample>

export const DockedAndClosable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByLabelText("Close trace inspector")
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByLabelText("Close trace inspector"))
    await expect(canvas.getByText("Inspector closed")).toBeVisible()
  },
}

export const MaximizeAndRestore: Story = {
  beforeEach: () => {
    localStorage.removeItem("datool:trace-inspector:tab")
    localStorage.removeItem("datool:trace-inspector:detail-tab")
    const url = window.location.href
    return () => window.history.replaceState(null, "", url)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const originalUrl = window.location.href
    const maximize = await canvas.findByRole("button", { name: "Maximize trace" })
    const inspector = maximize.closest("section")!
    const originalBounds = inspector.getBoundingClientRect()
    const workspace = canvas.getByText("Trace list workspace")
    const input = canvas.getByRole("textbox", { name: "Preserved list state" })
    await userEvent.clear(input)
    await userEvent.type(input, "Existing selection")

    await userEvent.click(maximize)
    await expect(canvas.findByRole("button", { name: "Restore trace panel" })).resolves.toBeVisible()
    await expect(new URL(window.location.href).searchParams.get("inspector")).toBe("full")
    await expect(workspace).not.toBeVisible()
    await expect(inspector.getBoundingClientRect().width).toBeGreaterThan(originalBounds.width)
    await expect(inspector.getBoundingClientRect().left).toBeCloseTo(canvasElement.getBoundingClientRect().left, 0)
    await expect(canvas.queryByRole("separator", { name: "Resize inspector" })).not.toBeInTheDocument()

    // Escape belongs to a nested picker before it restores the inspector.
    await userEvent.click(canvas.getByRole("combobox", { name: "Input view type" }))
    await expect(within(document.body).findByRole("listbox")).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(within(document.body).queryByRole("listbox")).not.toBeInTheDocument())
    await expect(canvas.getByRole("button", { name: "Restore trace panel" })).toBeVisible()
    canvas.getByRole("button", { name: "Restore trace panel" }).focus()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(window.location.href).toBe(originalUrl))
    await expect(workspace).toBeVisible()
    await expect(input).toHaveValue("Existing selection")
    await expect(canvas.getByRole("button", { name: "Maximize trace" })).toHaveFocus()
    await expect(canvas.getByRole("button", { name: "Maximize trace" }).closest("section")).toBe(inspector)
    await expect(inspector.getBoundingClientRect().width).toBeCloseTo(originalBounds.width, 0)

    window.history.forward()
    await waitFor(() => expect(canvas.getByRole("button", { name: "Restore trace panel" })).toBeVisible())
    window.history.back()
    await waitFor(() => expect(canvas.getByRole("button", { name: "Maximize trace" })).toBeVisible())
    await expect(input).toHaveValue("Existing selection")
    await userEvent.keyboard("{Escape}")
    await expect(canvas.getByText("Inspector closed")).toBeVisible()
  },
}

export const MobileFullscreen: Story = {
  beforeEach: MaximizeAndRestore.beforeEach,
  render: () => <div className="flex h-[640px] w-[390px] max-w-full flex-col"><OverlayExample /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const originalUrl = window.location.href
    const originalHistoryLength = window.history.length
    for (const closeWith of ["button", "Escape"]) {
      const close = await canvas.findByRole("button", { name: "Close trace inspector" })
      const inspector = close.closest("section")!
      await waitFor(() => expect(inspector.getBoundingClientRect().width).toBe(390))
      await expect(canvas.getByText("Trace list workspace")).not.toBeVisible()
      await expect(canvas.queryByRole("separator", { name: "Resize inspector" })).not.toBeInTheDocument()
      await expect(canvas.queryByRole("button", { name: /Maximize trace|Restore trace panel/ })).not.toBeInTheDocument()
      await expect(canvas.queryByRole("link", { name: "Open trace full page" })).not.toBeInTheDocument()
      await expect(window.location.href).toBe(originalUrl)
      await expect(window.history.length).toBe(originalHistoryLength)
      if (closeWith === "button") await userEvent.click(close)
      else {
        close.focus()
        await userEvent.keyboard("{Escape}")
      }
      await expect(canvas.getByText("Inspector closed")).toBeVisible()
      await expect(canvas.getByText("Trace list workspace")).toBeVisible()
      await waitFor(() => expect(canvas.getByRole("textbox", { name: "Preserved list state" })).toHaveFocus())
      if (closeWith === "button") await userEvent.click(canvas.getByRole("button", { name: "Open trace" }))
    }
  },
}

function ResponsiveOverlayExample() {
  const [narrow, setNarrow] = React.useState(false)
  return <>
    <Button onClick={() => setNarrow(value => !value)}>{narrow ? "Use desktop width" : "Use mobile width"}</Button>
    <div className={`flex h-[640px] max-w-full flex-col ${narrow ? "w-[390px]" : "w-full"}`}><OverlayExample /></div>
  </>
}

export const ResponsiveFullscreen: Story = {
  beforeEach: MaximizeAndRestore.beforeEach,
  render: () => <ResponsiveOverlayExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const maximize = await canvas.findByRole("button", { name: "Maximize trace" })
    const inspector = maximize.closest("section")!
    const resize = canvas.getByRole("separator", { name: "Resize inspector" })
    resize.focus()
    await userEvent.keyboard("{ArrowLeft}")
    const desktopSize = resize.getAttribute("aria-valuenow")
    const input = canvas.getByRole("textbox", { name: "Preserved list state" })
    await userEvent.clear(input)
    await userEvent.type(input, "Saved filter")

    await userEvent.click(canvas.getByRole("button", { name: "Use mobile width" }))
    await waitFor(() => expect(inspector.getBoundingClientRect().width).toBe(390))
    await expect(canvas.getByText("Trace list workspace")).not.toBeVisible()
    await expect(canvas.queryByRole("button", { name: "Maximize trace" })).not.toBeInTheDocument()

    await userEvent.click(canvas.getByRole("button", { name: "Use desktop width" }))
    await expect(canvas.findByRole("button", { name: "Maximize trace" })).resolves.toBeVisible()
    await expect(canvas.getByRole("separator", { name: "Resize inspector" })).toHaveAttribute("aria-valuenow", desktopSize)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue("Saved filter")
    await expect(canvas.getByRole("button", { name: "Maximize trace" }).closest("section")).toBe(inspector)
  },
}

export const MaximizedLink: Story = {
  beforeEach: () => {
    const originalUrl = window.location.href
    const url = new URL(originalUrl)
    url.searchParams.set("inspector", "full")
    window.history.replaceState(null, "", url)
    return () => window.history.replaceState(null, "", originalUrl)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const restore = await canvas.findByRole("button", { name: "Restore trace panel" })
    await expect(restore).toBeVisible()
    restore.focus()
    await userEvent.keyboard("{Escape}")
    await expect(canvas.getByRole("button", { name: "Maximize trace" })).toBeVisible()
    await expect(new URL(window.location.href).searchParams.has("inspector")).toBe(false)
    await expect(canvas.getByText("Trace list workspace")).toBeVisible()
  },
}

export const CloseWhileMaximized: Story = {
  beforeEach: MaximizeAndRestore.beforeEach,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const originalUrl = window.location.href
    await userEvent.click(await canvas.findByRole("button", { name: "Maximize trace" }))
    await expect(canvas.findByRole("button", { name: "Restore trace panel" })).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await expect(canvas.getByText("Inspector closed")).toBeVisible()
    await expect(canvas.queryByRole("button", { name: "Maximize trace" })).not.toBeInTheDocument()
    await expect(window.location.href).toBe(originalUrl)
    await expect(canvas.getByText("Trace list workspace")).toBeVisible()
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Preserved list state" })).toHaveFocus())
  },
}

export const CloseMaximizedLink: Story = {
  beforeEach: MaximizedLink.beforeEach,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("button", { name: "Restore trace panel" })).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await expect(canvas.getByText("Inspector closed")).toBeVisible()
    await expect(new URL(window.location.href).searchParams.has("inspector")).toBe(false)
    await expect(canvas.getByText("Trace list workspace")).toBeVisible()
  },
}

import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useTraceViewer } from "./context"
import { useImmediateStyle } from "./util/use-immediate-style"
import { useTrackpadZoom } from "./util/use-trackpad-zoom"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  StorySurface,
  TraceSurface,
  demoTrace,
} from "@/.storybook/scenarios/datool/fixtures"
import {
  TraceViewer as DirectTraceViewer,
  TraceViewerPanel,
  TraceViewerProvider,
  TraceViewerTimeline,
} from "./trace-viewer"
import { TraceViewer as PublicTraceViewer } from "./index"
import {
  ButtonLink,
  IconChevronDown,
  IconCross,
  IconExternalSmall,
  Link,
  Note,
  Skeleton,
} from "./components/ui"

const meta = {
  component: DirectTraceViewer,
  render: () => (
    <TraceSurface>
      <DirectTraceViewer eagerRender trace={demoTrace} />
    </TraceSurface>
  ),
  title: "Datool/TraceViewer",
} satisfies Meta<typeof DirectTraceViewer>

export default meta
type Story = StoryObj<typeof meta>

export const ZoomAndSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(
      canvas.findByRole("button", { name: /Parse invoice/ })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Zoom In" }))
    await userEvent.click(canvas.getByRole("button", { name: /Parse invoice/ }))
    await expect(
      canvas.findByRole("button", { name: "Close Span Details" })
    ).resolves.toBeVisible()
  },
}

export const DetachedDetailPanel: Story = {
  render: () => (
    <TraceSurface>
      <TraceViewerProvider>
        <div className="flex h-full min-w-0">
          <div className="min-w-0 flex-1">
            <TraceViewerTimeline
              eagerRender
              hideMiniMap
              hideSearchBar
              selectedSpanId="trace-parse"
              trace={demoTrace}
              withPanel={false}
            />
          </div>
          <TraceViewerPanel className="w-80 shrink-0" />
        </div>
      </TraceViewerProvider>
    </TraceSurface>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.tab()
    await expect(
      canvas.getByRole("region", { name: "Scrollable trace spans" })
    ).toHaveFocus()
  },
}

export const PublicBarrelExport: Story = {
  render: () => (
    <TraceSurface>
      <PublicTraceViewer
        eagerRender
        hideMiniMap
        hideSearchBar
        trace={demoTrace}
        withPanel={false}
      />
    </TraceSurface>
  ),
}

export const DetailPrimitives: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap items-center gap-4 text-foreground-muted">
        <IconCross />
        <IconChevronDown />
        <IconExternalSmall />
        <Link href="#trace-link">Trace link</Link>
        <ButtonLink href="#trace-action">Trace action</ButtonLink>
        <Note>Selection note</Note>
        <Skeleton height={18} rounded width={96} />
      </div>
    </StorySurface>
  ),
}

function HighlightExample({ eagerRender }: { eagerRender: boolean }) {
  const [highlightedSpans, setHighlightedSpans] = useState<string[]>(["trace-parse"])
  return (
    <TraceSurface>
      <Button onClick={() => setHighlightedSpans([])}>Clear highlights</Button>
      <DirectTraceViewer height={500} trace={demoTrace} eagerRender={eagerRender} highlightedSpans={highlightedSpans} />
    </TraceSurface>
  )
}

export const HighlightUpdates: Story = {
  render: () => <HighlightExample eagerRender />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const parse = await canvas.findByRole("button", { name: /Parse invoice/ })
    const persist = await canvas.findByRole("button", { name: /Persist ledger entry/ })
    await waitFor(() => expect(getComputedStyle(persist).opacity).toBe("0.3"))
    await expect(getComputedStyle(parse).opacity).toBe("1")
    await userEvent.click(canvas.getByRole("button", { name: "Clear highlights" }))
    await waitFor(() => expect(getComputedStyle(canvas.getByRole("button", { name: /Persist ledger entry/ })).opacity).toBe("1"))
    await userEvent.click(canvas.getByRole("button", { name: /Parse invoice/ }))
    await expect(canvas.findByRole("button", { name: "Close Span Details" })).resolves.toBeVisible()
  },
}

export const ProgressiveHighlightUpdates: Story = {
  ...HighlightUpdates,
  render: () => <HighlightExample eagerRender={false} />,
}

function ImperativeInteractionExample() {
  const ref = useRef<HTMLDivElement>(null)
  const [revision, setRevision] = useState(0)
  const [zoom, setZoom] = useState(0)
  const { style, setStyle } = useImmediateStyle(ref)
  useTrackpadZoom((delta) => setZoom(delta * (revision + 1)))
  return (
    <StorySurface>
      <Button onClick={() => setStyle("width", "120px")}>Resize marker</Button>
      <Button onClick={() => setRevision((value) => value + 1)}>Rerender marker</Button>
      <div ref={ref} style={{ ...style, width: 10 + revision }} aria-label="Marker probe">Marker</div>
      <output aria-label="Zoom delta">{zoom}</output>
    </StorySurface>
  )
}

export const ImperativeInteractions: Story = {
  render: () => <ImperativeInteractionExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const marker = canvas.getByLabelText("Marker probe")
    await userEvent.click(canvas.getByRole("button", { name: "Resize marker" }))
    await expect(marker.style.width).toBe("120px")
    await userEvent.click(canvas.getByRole("button", { name: "Rerender marker" }))
    await expect(marker.style.width).toBe("120px")
    canvasElement.ownerDocument.defaultView!.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -2, cancelable: true }))
    await waitFor(() => expect(canvas.getByLabelText("Zoom delta")).toHaveTextContent("4"))
  },
}

function QuickLinkProbe() {
  const { state } = useTraceViewer()
  return <output aria-label="Quick links">{state.getQuickLinks(demoTrace.spans[0]).map((link) => link.key).join(", ")}</output>
}

function QuickLinkExample() {
  const [revision, setRevision] = useState(1)
  const getQuickLinks = useCallback(() => [{
    key: `Source revision ${revision}`,
    value: Promise.resolve({ label: `Source revision ${revision}`, href: `#source-${revision}` }),
  }], [revision])
  return (
    <TraceSurface>
      <Button onClick={() => setRevision(2)}>Update quick links</Button>
      <TraceViewerProvider getQuickLinks={getQuickLinks}>
        <QuickLinkProbe />
      </TraceViewerProvider>
    </TraceSurface>
  )
}

export const QuickLinkUpdates: Story = {
  render: () => <QuickLinkExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Quick links")).toHaveTextContent("Source revision 1")
    await userEvent.click(canvas.getByRole("button", { name: "Update quick links" }))
    await expect(canvas.getByLabelText("Quick links")).toHaveTextContent("Source revision 2")
  },
}

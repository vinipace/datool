"use client"

import * as React from "react"
import { useDefaultLayout } from "react-resizable-panels"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

export function ReviewPanels({
  trace,
  children,
}: React.PropsWithChildren<{ trace: React.ReactNode }>) {
  const container = React.useRef<HTMLDivElement>(null)
  const [horizontal, setHorizontal] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setHorizontal(entry.contentRect.width >= 1024)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={container} className="min-h-0 flex-1">
      {horizontal !== null && (
        <ReviewPanelGroup
          key={String(horizontal)}
          horizontal={horizontal}
          trace={trace}
        >
          {children}
        </ReviewPanelGroup>
      )}
    </div>
  )
}

function ReviewPanelGroup({
  horizontal,
  trace,
  children,
}: React.PropsWithChildren<{ horizontal: boolean; trace: React.ReactNode }>) {
  const layout = useDefaultLayout({
    id: `review-panels-${horizontal ? "horizontal" : "vertical"}`,
    panelIds: ["review-trace", "review-scores"],
    onlySaveAfterUserInteractions: true,
  })
  return (
    <ResizablePanelGroup
      orientation={horizontal ? "horizontal" : "vertical"}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel
        id="review-trace"
        defaultSize={horizontal ? undefined : "55%"}
        minSize={horizontal ? "35%" : "25%"}
      >
        <div className="h-full min-h-0 min-w-0 overflow-hidden">{trace}</div>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize review scores" />
      <ResizablePanel
        id="review-scores"
        defaultSize={horizontal ? "360px" : "45%"}
        minSize={horizontal ? "280px" : "25%"}
      >
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

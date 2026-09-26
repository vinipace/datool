"use client"

import * as React from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { InspectorPanelContext } from "./inspector-panel-context"

export function InspectorPanels({ children }: React.PropsWithChildren) {
  const [open, setOpen] = React.useState(false)
  const [maximized, setMaximized] = React.useState(false)
  const [narrow, setNarrow] = React.useState(false)
  const [defaultSize, setDefaultSize] = React.useState(45)
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  const observeContainer = React.useCallback((element: HTMLDivElement | null) => {
    if (!element) return
    setNarrow(element.getBoundingClientRect().width < 768)
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 768))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const value = React.useMemo(() => ({ open, target, setOpen, setDefaultSize, maximized, setMaximized, narrow }), [open, target, maximized, narrow])
  return <InspectorPanelContext.Provider value={value}>
    <div ref={observeContainer} className="relative flex min-h-0 min-w-0 flex-1">
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="workspace" defaultSize={open ? `${100 - defaultSize}%` : "100%"} minSize="20%">
        <div inert={open && maximized} className={cn("h-full min-h-0 overflow-auto", open && maximized && "invisible")}>{children}</div>
      </ResizablePanel>
      {open && <ResizableHandle withHandle aria-label="Resize inspector" className={maximized ? "invisible" : undefined} />}
      {open && <ResizablePanel id="inspector" defaultSize={`${defaultSize}%`} minSize="20%" style={maximized ? { overflow: "visible" } : undefined}>
        <div ref={setTarget} className={cn("h-full min-h-0 overflow-hidden", maximized && "absolute inset-0 z-40 bg-background")} />
      </ResizablePanel>}
    </ResizablePanelGroup>
    </div>
  </InspectorPanelContext.Provider>
}

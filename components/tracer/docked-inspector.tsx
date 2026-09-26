"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { InspectorPanelContext } from "./inspector-panel-context"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

const subscribe = (listener: () => void) => {
  const query = window.matchMedia("(min-width: 768px)")
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
const desktopSnapshot = () => window.matchMedia("(min-width: 768px)").matches

/** Uses the workspace inspector dock, with a focus-contained sheet on small screens. */
export function DockedInspector({
  children,
  title,
  mobileOpen,
  onMobileClose,
}: React.PropsWithChildren<{
  title: string
  mobileOpen: boolean
  onMobileClose: () => void
}>) {
  const desktop = React.useSyncExternalStore(
    subscribe,
    desktopSnapshot,
    () => true
  )
  const panel = React.useContext(InspectorPanelContext)
  const setOpen = panel?.setOpen
  const setDefaultSize = panel?.setDefaultSize
  React.useEffect(() => {
    setDefaultSize?.(34)
    setOpen?.(desktop)
    return () => {
      setOpen?.(false)
      setDefaultSize?.(45)
    }
  }, [desktop, setOpen, setDefaultSize])
  if (!desktop)
    return (
      <Dialog
        open={mobileOpen}
        onOpenChange={(open) => {
          if (!open) onMobileClose()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[100dvh] max-h-none w-full max-w-none gap-0 rounded-none border-0 bg-background p-0"
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Inspect and edit dataset fields.
          </DialogDescription>
          {children}
        </DialogContent>
      </Dialog>
    )
  if (panel) return panel.target ? createPortal(children, panel.target) : null
  return (
    <aside className="h-full w-96 shrink-0 border-l border-border">
      {children}
    </aside>
  )
}

"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { InspectorPanelContext } from "./inspector-panel-context"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"

export function CollectionInspectorOverlay({
  title,
  description,
  isWide,
  onClose,
  onRestoreFocus,
  defaultSize = 45,
  children,
}: React.PropsWithChildren<{
  title: string
  description: string
  isWide: boolean
  onClose: () => void
  onRestoreFocus: () => void
  defaultSize?: number
}>) {
  const panel = React.useContext(InspectorPanelContext)
  const setOpen = panel?.setOpen
  const setDefaultSize = panel?.setDefaultSize
  React.useEffect(() => {
    if (!isWide) return
    setDefaultSize?.(defaultSize)
    setOpen?.(true)
    return () => {
      setOpen?.(false)
      setDefaultSize?.(45)
    }
  }, [isWide, setOpen, setDefaultSize, defaultSize])

  React.useEffect(() => {
    if (!isWide) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
        )
      )
        return
      event.preventDefault()
      onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isWide, onClose])

  if (isWide && panel)
    return panel.target ? createPortal(children, panel.target) : null
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  )
}

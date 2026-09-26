"use client"

import { createPortal } from "react-dom"
import { InspectorPanelContext } from "./inspector-panel-context"
import * as React from "react"
import { useSearchParams } from "next/navigation"

import { TraceInspector, type TraceInspectorProps } from "./trace-inspector"
import type { TraceDetail } from "@/src/lib/tracer/contracts"
import { useRemote } from "./hooks"
import { ErrorState, LoadingState } from "./primitives"
import { Button } from "@/components/ui/button"

type TraceInspectorOverlayProps = Omit<TraceInspectorProps, "mode"> & {
  onClose: () => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
  loadSnapshot?: (signal: AbortSignal) => Promise<TraceDetail | undefined>
}

function DeferredInspector({
  loadSnapshot,
  ...props
}: TraceInspectorProps & {
  loadSnapshot: (signal: AbortSignal) => Promise<TraceDetail | undefined>
}) {
  const state = useRemote(loadSnapshot, [props.traceId])
  if (state.isLoading || state.error)
    return (
      <div className="h-full overflow-auto p-4">
        <Button variant="ghost" onClick={props.onClose}>
          Close trace
        </Button>
        {state.isLoading ? (
          <LoadingState label="Loading eval evidence" />
        ) : (
          <ErrorState error={state.error!} onRetry={state.refresh} />
        )}
      </div>
    )
  return <TraceInspector {...props} snapshot={state.data ?? undefined} />
}

/**
 * The list owns the docked inspector lifecycle and restores focus on close.
 */
export function TraceInspectorOverlay({
  onClose,
  returnFocusRef,
  traceId,
  loadSnapshot,
  ...props
}: TraceInspectorOverlayProps) {
  const panel = React.useContext(InspectorPanelContext)
  const setOpen = panel?.setOpen
  const setMaximized = panel?.setMaximized
  const maximized = panel?.maximized ?? false
  const narrow = panel?.narrow ?? false
  const searchParams = useSearchParams()
  const maximizedFromPanel = React.useRef(false)
  const wasMaximized = React.useRef(false)
  const maximizeTrigger = React.useRef<HTMLElement | null>(null)
  const closing = React.useRef(false)
  const restoreListFocus = React.useCallback(() => {
    returnFocusRef?.current?.focus()
  }, [returnFocusRef])

  React.useLayoutEffect(() => {
    const sync = () => {
      const full = new URLSearchParams(window.location.search).get("inspector") === "full"
      const restoreFocus = wasMaximized.current && !full && !narrow
      wasMaximized.current = full
      setMaximized?.(full || narrow)
      if (restoreFocus) maximizeTrigger.current?.focus()
    }
    sync()
    window.addEventListener("popstate", sync)
    return () => window.removeEventListener("popstate", sync)
  }, [searchParams, setMaximized, narrow])

  React.useEffect(() => {
    setOpen?.(true)
    return () => {
      setOpen?.(false)
      setMaximized?.(false)
      // Wait until the inspector unmounts and the workspace is no longer inert.
      if (closing.current) {
        requestAnimationFrame(restoreListFocus)
      }
    }
  }, [setOpen, setMaximized, restoreListFocus])

  const restore = React.useCallback(() => {
    if (maximizedFromPanel.current) {
      window.history.back()
    } else {
      // A directly opened maximized URL has no split-view entry to go back to.
      const url = new URL(window.location.href)
      url.searchParams.delete("inspector")
      window.history.replaceState(null, "", url)
      setMaximized?.(false)
      maximizeTrigger.current?.focus()
    }
  }, [setMaximized])

  const toggleMaximize = React.useCallback(() => {
    if (maximized) {
      restore()
      return
    }
    maximizeTrigger.current = document.activeElement as HTMLElement | null
    const url = new URL(window.location.href)
    url.searchParams.set("inspector", "full")
    window.history.pushState(null, "", url)
    maximizedFromPanel.current = true
    wasMaximized.current = true
    setMaximized?.(true)
  }, [maximized, restore, setMaximized])

  const close = React.useCallback(() => {
    closing.current = true
    const url = new URL(window.location.href)
    if (url.searchParams.has("inspector")) {
      url.searchParams.delete("inspector")
      window.history.replaceState(null, "", url)
    }
    onClose()
  }, [onClose])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return
      // Let an editor or another open popup handle Escape first.
      if (
        Array.from(document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
        )).some(popup =>
          !popup.closest('[aria-hidden="true"]') &&
          popup.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        )
      )
        return
      event.preventDefault()
      if (maximized && !narrow) restore()
      else close()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [close, maximized, narrow, restore])

  const inspector = loadSnapshot ? (
    <DeferredInspector
      key={traceId}
      mode="panel"
      onClose={close}
      maximized={maximized}
      hideExpandControl={narrow}
      onToggleMaximize={panel ? toggleMaximize : undefined}
      traceId={traceId}
      loadSnapshot={loadSnapshot}
      {...props}
    />
  ) : (
    <TraceInspector
      key={traceId}
      mode="panel"
      onClose={close}
      maximized={maximized}
      hideExpandControl={narrow}
      onToggleMaximize={panel ? toggleMaximize : undefined}
      traceId={traceId}
      {...props}
    />
  )
  return panel
    ? panel.target
      ? createPortal(inspector, panel.target)
      : null
    : inspector
}

"use client"

import * as React from "react"
import { Plus, RefreshCw } from "lucide-react"
import { Combobox } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import type { ReactViewSummary } from "@/src/lib/tracer/react-views"
import { reactViewLibraryEvent } from "@/src/lib/tracer/react-view-preferences"
import { reactViewsApi } from "./api"
import { useRemote } from "./hooks"
import { useProjectScope } from "./project-scope-context"

export function TraceViewPicker({
  onOpenView,
  onCreateView,
  disabled,
}: {
  onOpenView: (view: ReactViewSummary) => void
  onCreateView: () => void
  disabled?: boolean
}) {
  const scope = useProjectScope()
  const [open, setOpen] = React.useState(false)
  const projectId = scope?.projectId
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      const views: ReactViewSummary[] = []
      if (!projectId) return views
      let cursor: string | undefined
      do {
        const page = await reactViewsApi.list(projectId, cursor, signal)
        views.push(
          ...page.items.filter((view) =>
            (view.objectTypes ?? ["trace", "dataset-item"]).includes("trace")
          )
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return views
    },
    [projectId]
  )
  const library = useRemote(load, [projectId])
  const refresh = library.refresh
  React.useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.projectId === projectId)
        refresh()
    }
    window.addEventListener(reactViewLibraryEvent, changed)
    return () => window.removeEventListener(reactViewLibraryEvent, changed)
  }, [projectId, refresh])
  return (
    <Combobox
      label="Open view"
      variant="tab"
      triggerContent={<Plus className="size-3.5" />}
      open={open}
      onOpenChange={setOpen}
      value={null}
      disabled={disabled || !scope || library.isLoading}
      options={(library.data ?? []).map((view) => ({
        value: view.id,
        label: view.name,
        description: view.description,
        keywords: [view.description],
      }))}
      onValueChange={(id) => {
        const view = library.data?.find((view) => view.id === id)
        if (view) {
          setOpen(false)
          onOpenView(view)
        }
      }}
      searchPlaceholder="Search project views…"
      popupClassName="w-80 max-w-[calc(100vw-2rem)]"
      popupFooter={
        <div className="space-y-2">
          {library.error && (
            <Notice variant="error">
              Could not load project views.{" "}
              <Button variant="ghost" size="sm" onClick={refresh}>
                <RefreshCw />
                Retry
              </Button>
            </Notice>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={!!library.error}
            onClick={() => {
              setOpen(false)
              onCreateView()
            }}
          >
            <Plus />
            Create new view
          </Button>
        </div>
      }
    />
  )
}

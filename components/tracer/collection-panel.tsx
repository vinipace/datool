"use client"

import * as React from "react"
import { CollectionToolbarSkeleton } from "@/components/ui/collection-skeleton"
import { cn } from "@/lib/utils"

import { CollectionHeaderContext } from "./collection-header-context"
import { PageViewSurface } from "./page-view-surface"

/** A collection owns its data controls; the surrounding page owns navigation. */
export function CollectionPanel({
  label,
  children,
  selectionControls,
  heading,
  refreshInMenu: alwaysRefreshInMenu = false,
  displayIconOnly = false,
  contentClassName,
}: React.PropsWithChildren<{
  label: string
  selectionControls?: React.ReactNode
  heading?: React.ReactNode
  refreshInMenu?: boolean
  displayIconOnly?: boolean
  contentClassName?: string
}>) {
  const { title, tabs } = React.useContext(CollectionHeaderContext)
  const panelRef = React.useRef<HTMLElement>(null)
  const [refreshInMenu, setRefreshInMenu] = React.useState(false)
  const [filter, setFilter] = React.useState<HTMLDivElement | null>(null)
  const [pageView, setPageView] = React.useState<HTMLDivElement | null>(null)
  const [actions, setActions] = React.useState<HTMLDivElement | null>(null)
  const [refresh, setRefresh] = React.useState<HTMLDivElement | null>(null)
  const [display, setDisplay] = React.useState<HTMLDivElement | null>(null)
  const [menu, setMenu] = React.useState<HTMLDivElement | null>(null)
  const [selection, setSelection] = React.useState<HTMLDivElement | null>(null)

  React.useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    setRefreshInMenu(panel.getBoundingClientRect().width < 480)
    // Menu content is portaled outside the panel's CSS container.
    const observer = new ResizeObserver(([entry]) => {
      setRefreshInMenu(entry.contentRect.width < 480)
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  return (
    <CollectionHeaderContext.Provider
      value={{
        title,
        tabs,
        filter,
        pageView,
        actions,
        refresh,
        display,
        menu,
        selection,
        refreshInMenu: alwaysRefreshInMenu || refreshInMenu,
        displayIconOnly,
      }}
    >
      {/* The nearest container also makes shared control labels follow panel width. */}
      <section
        ref={panelRef}
        aria-label={label}
        className="@container/page flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <div
          role="group"
          aria-label={`${label} controls`}
          className={cn(
            "@container/collection relative z-20 min-h-[53px] shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2",
            !heading && !filter && "@max-[640px]/page:min-h-[97px]",
            heading ? "grid grid-cols-[minmax(0,1fr)_auto]" : "flex @max-[640px]/page:flex-wrap"
          )}
        >
          {!filter && (
            <div className="pointer-events-none absolute inset-0">
              <CollectionToolbarSkeleton />
            </div>
          )}
          {heading && <div className="min-w-0">{heading}</div>}
          <div
            ref={setSelection}
            className={cn(
              "peer/collection-selection flex min-w-0 flex-1 empty:hidden",
              heading && "justify-self-end"
            )}
          >
            {selectionControls}
          </div>
          {/* Retain portal targets and filter state while selection actions replace the toolbar. */}
          <div className="contents peer-[:not(:empty)]/collection-selection:hidden">
            <div ref={setPageView} className="flex min-w-0 flex-1 items-center empty:hidden @min-[640px]/page:flex-initial" />
            <div
              ref={setFilter}
              className={cn(
                "flex min-w-0 flex-1 items-center empty:hidden",
                !heading && "@max-[640px]/page:order-last @max-[640px]/page:basis-full",
                heading && "col-span-2 row-start-2"
              )}
            />
            <div
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1",
                heading && "col-start-2 row-start-1"
              )}
            >
              <div
                ref={setActions}
                className="flex items-center gap-2 empty:hidden"
              />
              <div
                ref={setRefresh}
                className="flex items-center empty:hidden"
              />
              <div
                ref={setDisplay}
                className="flex items-center empty:hidden"
              />
              <div ref={setMenu} className="flex items-center empty:hidden" />
            </div>
          </div>
        </div>
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-3 py-1 [&>*]:shrink-0", contentClassName)}>
          <PageViewSurface>{children}</PageViewSurface>
        </div>
      </section>
    </CollectionHeaderContext.Provider>
  )
}

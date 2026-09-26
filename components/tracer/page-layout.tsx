"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { CollectionHeaderContext } from "./collection-header-context"

type PageBreadcrumb = {
  label: string
  href: string
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
}

/** Shared breadcrumb links for route-based pages and editors opened in place. */
export function PageBreadcrumbs({
  items,
  trailingSeparator = false,
}: {
  items: PageBreadcrumb[]
  trailingSeparator?: boolean
}) {
  if (!items.length) return null
  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="flex min-w-0 items-center gap-2">
          {items.map((breadcrumb, index) => (
            <li
              key={breadcrumb.href}
              className="flex min-w-0 items-center gap-2"
            >
              {index > 0 && (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-muted"
                />
              )}
              <Link
                href={breadcrumb.href}
                onClick={breadcrumb.onClick}
                className="truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {breadcrumb.label}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      {trailingSeparator && (
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-foreground-muted"
        />
      )}
    </>
  )
}

type PageLayoutProps = React.PropsWithChildren<{
  title?: React.ReactNode
  breadcrumbs?: PageBreadcrumb[]
  leading?: React.ReactNode
  filters?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}>

/** The shared page frame: identity, filters and actions above flexible content.
 * CollectionHeaderControls and table controls can also populate its header slots.
 */
export function PageLayout({
  title,
  breadcrumbs = [],
  leading,
  filters,
  actions,
  className,
  children,
}: PageLayoutProps) {
  const [titleTarget, setTitleTarget] = React.useState<HTMLDivElement | null>(
    null
  )
  const [tabsTarget, setTabsTarget] = React.useState<HTMLDivElement | null>(null)
  const [filter, setFilter] = React.useState<HTMLDivElement | null>(null)
  const [actionTarget, setActions] = React.useState<HTMLDivElement | null>(null)
  const [refresh, setRefresh] = React.useState<HTMLDivElement | null>(null)
  const [display, setDisplay] = React.useState<HTMLDivElement | null>(null)
  const [menu, setMenu] = React.useState<HTMLDivElement | null>(null)

  return (
    <CollectionHeaderContext.Provider
      value={{
        title: titleTarget,
        tabs: tabsTarget,
        filter,
        actions: actionTarget,
        refresh,
        display,
        menu,
      }}
    >
      <div
        className={cn(
          "@container/page flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background text-foreground",
          className
        )}
      >
        <header
          aria-label="Page controls"
          className="sticky top-0 z-30 -ml-px flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-sidebar-border bg-sidebar px-2 py-1.5 @min-[640px]/page:h-10 @min-[640px]/page:flex-nowrap @min-[640px]/page:gap-2"
        >
          {leading && (
            <>
              <div className="shrink-0">{leading}</div>
              <span
                aria-hidden="true"
                className="h-4 w-px shrink-0 bg-border"
              />
            </>
          )}
          <div
            ref={setTabsTarget}
            className="peer/page-tabs -my-1.5 flex min-w-0 self-stretch pt-1 empty:hidden"
          />
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium peer-[:not(:empty)]/page-tabs:sr-only @min-[640px]/page:max-w-1/2 @min-[640px]/page:flex-initial">
            <PageBreadcrumbs items={breadcrumbs} trailingSeparator={!!title} />
            <div className="min-w-0">
              <div ref={setTitleTarget} className="peer min-w-0 empty:hidden" />
              {title && (
                <h1 className="truncate text-sm font-medium peer-[:not(:empty)]:hidden">
                  {title}
                </h1>
              )}
            </div>
          </div>
          <div
            className="order-last flex min-w-0 basis-full items-center empty:hidden @min-[640px]/page:order-none @min-[640px]/page:ml-2 @min-[640px]/page:flex-1 @min-[640px]/page:basis-auto @min-[640px]/page:empty:block"
            ref={setFilter}
          >
            {filters}
          </div>
          <div
            className="ml-auto flex shrink-0 items-center gap-2 empty:hidden @min-[640px]/page:ml-0"
            ref={setActions}
          >
            {actions}
          </div>
          <div
            className="flex shrink-0 items-center empty:hidden"
            ref={setRefresh}
          />
          <div
            className="flex shrink-0 items-center empty:hidden"
            ref={setDisplay}
          />
          <div
            className="flex shrink-0 items-center gap-1 empty:hidden"
            ref={setMenu}
          />
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </CollectionHeaderContext.Provider>
  )
}

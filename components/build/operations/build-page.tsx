"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Inbox,
  RefreshCw,
  Search,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { CollectionTableSkeleton } from "@/components/ui/collection-skeleton"
import { CollectionPage } from "@/components/tracer/collection-page"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionRow, CollectionTable } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { StatusPill } from "@/components/tracer/primitives"
import { cn } from "@/lib/utils"

export function BuildFrame({
  title,
  description,
  breadcrumbs = [],
  actions,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  breadcrumbs?: { label: string; href: string }[]
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const panelLabel =
    breadcrumbs.at(-1)?.label ??
    (typeof title === "string" ? title : "Build operations")
  const state = React.useMemo(
    () => ({
      data: {},
      error: null,
      isLoading: false,
      isRefreshing: false,
      refresh: () => undefined,
    }),
    []
  )

  return (
    <CollectionPanel label={panelLabel}>
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel={`Loading ${panelLabel}`}
        header={{ actions, showExport: false, showRefresh: false }}
      >
        <div className="mx-auto min-h-0 w-full max-w-[1440px] flex-1 space-y-6 bg-background px-1 py-5 sm:px-3 sm:py-6">
          <header className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="max-w-2xl text-sm leading-relaxed text-foreground-muted">{description}</p>
            ) : null}
          </header>
          {children}
        </div>
      </CollectionPage>
    </CollectionPanel>
  )
}

export function BuildToolbar({
  search,
  onSearch,
  placeholder = "Search…",
  children,
}: {
  search?: string
  onSearch?: (value: string) => void
  placeholder?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onSearch ? (
        <div className="w-full max-w-sm">
          <Input
            value={search ?? ""}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            icon={<Search />}
            className="h-8 text-xs"
          />
        </div>
      ) : null}
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}

export function BuildTable({
  columns,
  children,
  empty,
}: {
  columns: string[]
  children: React.ReactNode
  empty?: React.ReactNode
}) {
  const columnIds = columns.map((column, index) =>
    `${column.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "column"}-${index}`
  )

  return (
    <div className="min-w-0">
      <CollectionTable
        enableCardView={false}
        enableRowHeight={false}
        displayControls={false}
        reorderable={false}
        widths={columns.map((_, index) => (index === 0 ? 260 : 150))}
        columnIds={columnIds}
      >
        <thead className={collectionTable.head}>
          <tr>
            <th aria-hidden className={collectionTable.heading} />
            {columns.map((column) => (
              <th key={column} className={collectionTable.heading}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </CollectionTable>
      {empty ? <div className="border-t border-border">{empty}</div> : null}
    </div>
  )
}

export function BuildRow({
  children,
  onClick,
  selected = false,
}: {
  children: React.ReactNode
  onClick?: () => void
  selected?: boolean
}) {
  return (
    <CollectionRow
      className={cn(
        selected && "bg-selection/30",
      )}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      <td aria-hidden className={collectionTable.cell} />
      {children}
    </CollectionRow>
  )
}

export function BuildCell({
  children,
  className,
}: React.PropsWithChildren<{ className?: string }>) {
  return <td className={cn(collectionTable.cell, className)}>{children}</td>
}

export function BuildState({
  isLoading,
  error,
  onRetry,
  children,
}: {
  isLoading: boolean
  error: Error | null
  onRetry: () => void
  children: React.ReactNode
}) {
  if (isLoading) {
    return (
      <CollectionTableSkeleton label="Loading this view" rows={4} />
    )
  }
  if (error) {
    return (
      <Notice variant="error" title="Unable to load this view" role="alert">
        <div className="flex flex-wrap items-center gap-3">
          <span>{error.message}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      </Notice>
    )
  }
  return children
}

export function BuildEmpty({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 grid size-11 place-items-center rounded-xl border border-border bg-muted text-foreground-muted">
        <Inbox className="size-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-sm text-foreground-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function BuildFormCard({
  title,
  description,
  children,
  footer,
}: React.PropsWithChildren<{
  title: string
  description?: string
  footer?: React.ReactNode
}>) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-4">
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
      {footer ? <div className="border-t border-border px-5 py-3">{footer}</div> : null}
    </Card>
  )
}

export function FormLabel({
  label,
  hint,
  hintPlacement = "inline",
  children,
}: React.PropsWithChildren<{ label: string; hint?: string; hintPlacement?: "inline" | "below" }>) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-foreground">
        {label}
        {hint && hintPlacement === "inline" ? <span className="ml-2 font-normal text-foreground-muted">{hint}</span> : null}
      </span>
      {hint && hintPlacement === "below" ? <span className="text-xs leading-5 text-foreground-muted">{hint}</span> : null}
      {children}
    </label>
  )
}

export function BuildStatus({ status }: { status?: string | null }) {
  return status ? <StatusPill status={status} /> : <span className="text-foreground-muted">—</span>
}

export function BuildBackLink({
  href,
  children = "Back",
}: {
  href: string
  children?: React.ReactNode
}) {
  return (
    <Button variant="ghost-muted" size="sm" asChild>
      <Link href={href}>
        <ArrowLeft className="size-3.5" /> {children}
      </Link>
    </Button>
  )
}

export function BuildSection({
  title,
  description,
  children,
}: React.PropsWithChildren<{ title: string; description?: string }>) {
  return (
    <section className="rounded-lg border border-border bg-muted">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-xs text-foreground-muted">{description}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

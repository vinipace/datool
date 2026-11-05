"use client"

import * as React from "react"
import Link from "next/link"
import { Popover } from "radix-ui"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Plus,
  Search,
} from "lucide-react"
import { Button, buttonVariants } from "./button"
import { Input } from "./input"
import { cn } from "@/lib/utils"

type ResourceSwitcherItem = { id: string; name: string; href: string }

/** Searchable navigation shared by the organization and project selectors. */
export function ResourceSwitcher({
  label,
  value,
  items,
  onItemSelect,
  selectedId,
  search,
  onSearchChange,
  open,
  onOpenChange,
  loading,
  error,
  onRetry,
  onCreate,
  moreHref,
  moreLabel = "View all projects",
  onMoreSelect,
  renderItem,
  submenu,
  triggerRef,
  leadingIcon,
  triggerClassName,
}: {
  label: "organization" | "project"
  value: string
  items: ResourceSwitcherItem[]
  /** Custom selection owns closing, so a failed switch can stay visible. */
  onItemSelect?: (item: ResourceSwitcherItem) => void
  renderItem?: (
    item: ResourceSwitcherItem,
    close: () => void
  ) => React.ReactNode
  submenu?: { selected: boolean }
  selectedId?: string
  search: string
  onSearchChange: (value: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  error: Error | null
  onRetry: () => void
  onCreate?: () => void
  moreHref?: string
  moreLabel?: string
  onMoreSelect?: () => void
  triggerRef?: React.Ref<HTMLButtonElement>
  leadingIcon?: React.ReactNode
  triggerClassName?: string
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const openingCreateDialog = React.useRef(false)
  const plural = label === "organization" ? "Organizations" : "Projects"
  const isSubmenu = Boolean(submenu)
  const [narrow, setNarrow] = React.useState(false)

  React.useEffect(() => {
    if (!isSubmenu) return
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [isSubmenu])

  function moveFocus(event: React.KeyboardEvent) {
    // Events from a portalled submenu bubble through the parent React tree.
    if (!event.currentTarget.contains(event.target as Node)) return
    if (submenu && event.key === "ArrowLeft" && event.target === input.current)
      return
    if (submenu && event.key === "ArrowLeft") {
      event.preventDefault()
      event.stopPropagation()
      onOpenChange(false)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const targets = Array.from(
      content.current?.querySelectorAll<HTMLElement>(
        "input, a[href], button:not(:disabled)"
      ) ?? []
    )
    const index = targets.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    targets[
      (index + (event.key === "ArrowDown" ? 1 : -1) + targets.length) %
        targets.length
    ]?.focus()
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          aria-label={
            submenu ? `Projects in ${value}` : `Switch ${label}: ${value}`
          }
          aria-current={submenu?.selected ? "true" : undefined}
          title={value}
          onKeyDown={(event) => {
            if (submenu && event.key === "ArrowRight") {
              event.preventDefault()
              event.stopPropagation()
              onOpenChange(true)
            }
          }}
          className={cn(
            "min-w-0 justify-between gap-2 px-2 text-sm has-[>svg]:px-2 data-[state=open]:bg-muted",
            label === "project" ? "w-full" : "max-w-full",
            submenu &&
              "h-10 w-full justify-start gap-3 px-3 font-normal has-[>svg]:px-3",
            triggerClassName
          )}
        >
          {submenu ? (
            <Check
              aria-hidden="true"
              className={cn("size-4", !submenu.selected && "invisible")}
            />
          ) : (
            leadingIcon
          )}
          <span className="min-w-0 flex-1 truncate text-left">{value}</span>
          {submenu ? (
            <ChevronRight className="size-3.5 text-foreground-muted" />
          ) : label === "project" ? (
            <ChevronsUpDown className="size-3.5 text-foreground-muted" />
          ) : (
            <ChevronDown className="size-3.5 text-foreground-muted" />
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          aria-label={`Choose ${label}`}
          align="start"
          side={submenu && !narrow ? "right" : "bottom"}
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            input.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            if (openingCreateDialog.current) event.preventDefault()
            openingCreateDialog.current = false
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenChange(false)
          }}
          onKeyDown={moveFocus}
          className="z-50 flex max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-border bg-background p-2 text-foreground shadow-xl outline-none"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-2">
            {submenu && narrow ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back to organizations"
                onClick={() => onOpenChange(false)}
              >
                <ChevronLeft className="size-4" />
              </Button>
            ) : (
              <Search
                aria-hidden="true"
                className="size-4 shrink-0 text-foreground-muted"
              />
            )}
            <Input
              ref={input}
              aria-label={`Find ${label}`}
              placeholder={`Find ${label}`}
              maxLength={label === "project" ? 120 : undefined}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="h-9 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="min-h-0 overflow-y-auto py-2">
            <p className="px-3 py-2 text-xs text-foreground-muted">{plural}</p>
            {loading ? (
              <p
                role="status"
                className="px-3 py-2 text-sm text-foreground-muted"
              >
                Loading {plural.toLowerCase()}…
              </p>
            ) : null}
            {error ? (
              <div role="alert" className="px-3 py-2 text-sm text-destructive">
                <p>{error.message}</p>
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : null}
            {!loading && !error && !items.length ? (
              <p
                role="status"
                className="px-3 py-2 text-sm text-foreground-muted"
              >
                {search
                  ? `No matching ${plural.toLowerCase()}.`
                  : `No ${plural.toLowerCase()} yet.`}
              </p>
            ) : null}
            {items.map((item) =>
              renderItem ? (
                <React.Fragment key={item.id}>
                  {renderItem(item, () => onOpenChange(false))}
                </React.Fragment>
              ) : (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={(event) => {
                    if (onItemSelect) {
                      event.preventDefault()
                      onItemSelect(item)
                    } else {
                      onOpenChange(false)
                    }
                  }}
                  aria-current={item.id === selectedId ? "true" : undefined}
                  className={cn(
                    buttonVariants({ variant: "ghost" }),
                    "h-10 w-full justify-start gap-3 px-3 font-normal"
                  )}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-4",
                      item.id !== selectedId && "invisible"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.id === selectedId && !submenu ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3.5 text-foreground-muted"
                    />
                  ) : null}
                </Link>
              )
            )}
            {moreHref ? (
              <Button
                asChild
                variant="ghost-muted"
                size="sm"
                className="mt-1 w-full"
              >
                <Link
                  href={moreHref}
                  onClick={(event) => {
                    if (onMoreSelect) {
                      event.preventDefault()
                      onMoreSelect()
                    } else {
                      onOpenChange(false)
                    }
                  }}
                >
                  {moreLabel}
                </Link>
              </Button>
            ) : null}
          </div>
          {onCreate ? (
            <div className="shrink-0 border-t border-border pt-2">
              <Button
                variant="ghost"
                onClick={() => {
                  openingCreateDialog.current = true
                  onOpenChange(false)
                  onCreate()
                }}
                className="h-10 w-full justify-start gap-3 px-3 font-normal"
              >
                <Plus className="size-4" />
                Create {label}
              </Button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

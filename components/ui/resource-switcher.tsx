"use client"

import * as React from "react"
import Link from "next/link"
import { Popover } from "radix-ui"
import { Check, ChevronDown, ChevronRight, Plus, Search } from "lucide-react"
import { Button, buttonVariants } from "./button"
import { Input } from "./input"
import { cn } from "@/lib/utils"

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
  triggerRef,
  leadingIcon,
}: {
  label: "organization" | "project"
  value: string
  items: { id: string; name: string; href: string }[]
  onItemSelect?: (item: { id: string; name: string; href: string }) => void
  selectedId?: string
  search: string
  onSearchChange: (value: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  error: Error | null
  onRetry: () => void
  onCreate: () => void
  moreHref?: string
  triggerRef?: React.Ref<HTMLButtonElement>
  leadingIcon?: React.ReactNode
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const openingCreateDialog = React.useRef(false)
  const plural = label === "organization" ? "Organizations" : "Projects"

  function moveFocus(event: React.KeyboardEvent) {
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
          aria-label={`Switch ${label}: ${value}`}
          title={value}
          className={cn(
            "min-w-0 justify-between gap-2 px-2 text-sm data-[state=open]:bg-muted has-[>svg]:px-2",
            label === "project" ? "w-full" : "max-w-full"
          )}
        >
          {leadingIcon}
          <span className="min-w-0 flex-1 truncate text-left">{value}</span>
          <ChevronDown className="size-3.5 text-foreground-muted" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          aria-label={`Choose ${label}`}
          align="start"
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
            <Search
              aria-hidden="true"
              className="size-4 shrink-0 text-foreground-muted"
            />
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
            {items.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                onClick={(event) => {
                  onOpenChange(false)
                  if (onItemSelect) {
                    event.preventDefault()
                    onItemSelect(item)
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
                {item.id === selectedId ? (
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 text-foreground-muted"
                  />
                ) : null}
              </Link>
            ))}
            {moreHref ? (
              <Button
                asChild
                variant="ghost-muted"
                size="sm"
                className="mt-1 w-full"
              >
                <Link href={moreHref} onClick={() => onOpenChange(false)}>
                  View all projects
                </Link>
              </Button>
            ) : null}
          </div>
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

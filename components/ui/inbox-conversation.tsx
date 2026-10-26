"use client"

import type * as React from "react"
import { UserRoundPlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

const avatarTones = [
  "bg-inbox-avatar-amber text-inbox-avatar-ink",
  "bg-inbox-avatar-indigo text-inbox-avatar-light",
  "bg-inbox-avatar-rose text-inbox-avatar-ink",
  "bg-inbox-avatar-stone text-inbox-avatar-ink",
] as const

export function ConversationAvatar({
  name,
  identity = name,
  badge,
  compact = false,
}: {
  name: string
  identity?: string
  badge?: React.ReactNode
  compact?: boolean
}) {
  const hash = Array.from(identity).reduce(
    (value, char) => value + char.charCodeAt(0),
    0
  )
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0",
        compact ? "size-9" : "size-11"
      )}
    >
      <span
        className={cn(
          "relative flex size-full items-center justify-center overflow-hidden rounded-full text-sm font-semibold",
          avatarTones[hash % avatarTones.length]
        )}
      >
        <span className="absolute inset-y-0 left-0 w-1/2 bg-current opacity-10" />
        <span className="relative">{initials || "?"}</span>
      </span>
      {badge && (
        <span className="absolute -right-1 -bottom-1 overflow-hidden rounded-full border-2 border-background bg-muted">
          {badge}
        </span>
      )}
    </span>
  )
}

export function ConversationRow({
  selected,
  avatar,
  title,
  preview,
  timestamp,
  metadata,
  ...props
}: Omit<React.ComponentProps<"button">, "title"> & {
  selected: boolean
  avatar: React.ReactNode
  title: string
  preview: string
  timestamp?: React.ReactNode
  metadata?: React.ReactNode
}) {
  return (
    <button
      {...props}
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl px-3 py-4 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-inbox-selection hover:bg-inbox-selection"
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="truncate text-sm font-semibold text-foreground">
            {title}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-foreground-muted">
            {timestamp}
          </span>
        </span>
        <span className="line-clamp-2 text-sm leading-5 text-foreground-muted">
          {preview}
        </span>
        {metadata && (
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-foreground-muted">
            {metadata}
          </span>
        )}
      </span>
    </button>
  )
}

export function InboxQueueChip({
  selected,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { selected: boolean }) {
  return (
    <Button
      {...props}
      size="sm"
      variant="outline"
      aria-pressed={selected}
      className={cn(
        "rounded-full px-3.5",
        selected &&
          "border-transparent bg-inbox-selection text-inbox-selection-foreground hover:bg-inbox-selection"
      )}
    >
      {children}
    </Button>
  )
}

export function ConversationListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversations"
      className="space-y-2 px-1 py-2"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex gap-3 px-3 py-4 motion-safe:animate-pulse"
        >
          <span className="size-11 shrink-0 rounded-full bg-muted" />
          <span className="flex flex-1 flex-col gap-3 py-1">
            <span className="h-3 w-3/4 rounded bg-muted" />
            <span className="h-3 w-full rounded bg-muted" />
            <span className="h-3 w-1/2 rounded bg-muted" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A text label as well as color makes waiting handoffs easy to identify. */
export function TakeoverIndicator({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Needs takeover"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md text-xs font-medium text-warning",
        !compact && "bg-warning-background px-2 py-1"
      )}
    >
      <UserRoundPlus className="size-3.5" aria-hidden />
      <span className={compact ? "sr-only" : undefined}>Needs takeover</span>
    </span>
  )
}

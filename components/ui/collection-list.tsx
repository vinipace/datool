"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "@/lib/utils"

/** Compact, responsive resource rows with the same neutral canvas and focus as collections. */
export function CollectionList({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("divide-y divide-border border-y border-border", className)}
      {...props}
    />
  )
}
export function CollectionListItem({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "a"
  return (
    <Component
      className={cn(
        "grid min-w-0 items-center gap-x-4 gap-y-2 px-3 py-4 text-left text-sm text-foreground transition-colors outline-none hover:bg-surface-row-hover focus-visible:bg-surface-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className
      )}
      {...props}
    />
  )
}

export function CollectionBadge({
  active = false,
  children,
}: React.PropsWithChildren<{ active?: boolean }>) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
        active
          ? "border-selection-control bg-selection text-selection-foreground"
          : "border-border text-foreground-muted"
      )}
    >
      {children}
    </span>
  )
}

"use client"

import type { PropsWithChildren } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "./button"

export function SelectionToolbar({
  count,
  onClear,
  label = "Selected row actions",
  children,
}: PropsWithChildren<{ count: number; onClear: () => void; label?: string }>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="-m-0.5 flex h-10 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto p-0.5 @max-[480px]/collection:gap-1"
    >
      <Button
        variant="secondary"
        size="sm"
        onClick={onClear}
        aria-label={`Clear selection (${count} selected)`}
        className="bg-selection text-selection-foreground hover:bg-selection/80"
      >
        <X aria-hidden="true" className="size-3.5" />
        <span>
          {count}
          <span className="@max-[480px]/collection:sr-only"> selected</span>
        </span>
      </Button>
      {children}
    </div>
  )
}

/** Pair with PanelActionLabel to keep compact actions named at narrow widths. */
export function SelectionActionButton({ className, ...props }: ButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "@max-[640px]/collection:size-8 @max-[640px]/collection:p-0",
        className
      )}
      {...props}
    />
  )
}

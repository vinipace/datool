import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

/** Native radio behavior with a full-card label and visible keyboard focus. */
export function RadioCard({
  children,
  className,
  compact = false,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { compact?: boolean }) {
  return (
    <label className={cn("group relative block", className)}>
      <input {...props} type="radio" className="peer sr-only" />
      <span
        className={cn(
          "flex h-full cursor-pointer gap-3 rounded-lg border border-border bg-background text-foreground transition-colors peer-checked:border-selection-control peer-checked:bg-selection peer-checked:text-selection-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:pointer-events-none peer-disabled:opacity-50 hover:bg-surface-row-hover",
          compact ? "p-3" : "p-4"
        )}
      >
        <span className="min-w-0 flex-1">{children}</span>
        {!compact ? (
          <Check
            aria-hidden="true"
            className="invisible size-4 shrink-0 group-has-[:checked]:visible"
          />
        ) : null}
      </span>
    </label>
  )
}

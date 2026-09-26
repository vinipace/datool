"use client"

import type { ComponentProps, ReactNode } from "react"
import { ChevronDown, CircleAlert } from "lucide-react"
import { cn } from "@/lib/utils"

/** Shared framing for recorded Input, Output, and Error payloads. */
export function PayloadSection({
  label,
  headerDetail,
  children,
  open = true,
  onToggle,
}: {
  label: string
  headerDetail?: ReactNode
  children: ReactNode
} & Pick<ComponentProps<"details">, "open" | "onToggle">) {
  return (
    <details
      open={open}
      onToggle={onToggle}
      className={cn(
        "group/payload border-t",
        label === "Error"
          ? "-mx-3 border-b border-destructive-border bg-destructive-background px-3"
          : "border-foreground/18"
      )}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-normal text-foreground-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className={cn("flex items-center gap-2", label === "Error" && "text-destructive")}>
          <span aria-hidden="true" className="text-foreground-muted">
            {label === "Error" ? (
              <CircleAlert className="size-4 text-destructive" />
            ) : label === "Input" ? "↗" : "↘"}
          </span>
          {label}
        </span>
        <span className="flex items-center gap-2 text-[11px] font-normal text-foreground-muted">
          {headerDetail}
          <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/payload:rotate-180" />
        </span>
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  )
}

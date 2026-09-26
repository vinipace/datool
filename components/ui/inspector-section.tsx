"use client"

import type * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export function InspectorSection({
  label,
  icon,
  children,
  variant = "default",
  summaryClassName,
  defaultOpen = true,
}: React.PropsWithChildren<{
  label: string
  icon?: React.ReactNode
  variant?: "default" | "form"
  summaryClassName?: string
  defaultOpen?: boolean
}>) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group/section border-border",
        variant === "form" ? "border-b px-3 py-4" : "border-t py-3"
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          variant === "form" ? "h-8 text-foreground" : "text-foreground-muted",
          summaryClassName
        )}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronDown
          className={cn(
            "-mr-1 -ml-4.5 size-3.5 -rotate-90 text-muted-foreground group-open/section:rotate-0",
            variant === "form" && "order-first"
          )}
        />
      </summary>
      <div className={variant === "form" ? "mt-2" : "mt-3"}>{children}</div>
    </details>
  )
}

"use client"

import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"

export function InspectorTabs<Value extends string>({
  label,
  value,
  onValueChange,
  tabs,
  children,
}: {
  label: string
  value: Value
  onValueChange: (value: Value) => void
  tabs: {
    value: Value
    label: string
    icon: ComponentType<{ className?: string }>
  }[]
  children?: ReactNode
}) {
  return (
    <nav
      aria-label={label}
      className="scrollbar-hidden flex min-h-8 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-3 text-sm"
    >
      {tabs.map(({ value: tab, label: title, icon: Icon }) => (
        <button
          key={tab}
          type="button"
          aria-pressed={value === tab}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-foreground-muted transition-colors outline-none hover:bg-muted hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            value === tab &&
              "bg-foreground text-background hover:bg-foreground hover:text-background"
          )}
          onClick={() => onValueChange(tab)}
        >
          <Icon className="size-3.5" />
          {title}
        </button>
      ))}
      {children}
    </nav>
  )
}

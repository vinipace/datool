"use client"

import { useCallback, useEffect, useRef, type ComponentProps, type ComponentType, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { Button } from "./button"

export function InspectorTabs<Value extends string>({
  label,
  value,
  onValueChange,
  tabs,
  children,
  afterTabs,
  onActionsContainerChange,
}: {
  label: string
  value: Value
  onValueChange: (value: Value) => void
  tabs: {
    value: Value
    label: string
    icon: ComponentType<{ className?: string }>
    onClose?: () => void
    hasActions?: boolean
  }[]
  children?: ReactNode
  afterTabs?: ReactNode
  onActionsContainerChange?: (value: Value, container: HTMLDivElement | null) => void
}) {
  const navRef = useRef<HTMLElement>(null)
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [value, tabs.length])
  return (
    <nav
      ref={navRef}
      aria-label={label}
      className="scrollbar-hidden flex min-h-8 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-3 text-sm"
    >
      {tabs.map(({ value: tab, label: title, icon: Icon, onClose, hasActions }) => (
        <div
          key={tab}
          data-active={value === tab}
          className={cn(
            "group/inspector-tab flex shrink-0 self-end items-center rounded-t-md",
            value === tab && "bg-foreground text-background"
          )}
        >
          <button
            type="button"
            aria-pressed={value === tab}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-t-md px-2 text-xs font-medium whitespace-nowrap text-foreground-muted transition-colors outline-none hover:bg-muted hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              (onClose || hasActions) && "rounded-tr-none",
              value === tab &&
                "bg-foreground text-background hover:bg-foreground hover:text-background"
            )}
            onClick={() => onValueChange(tab)}
          >
            <Icon className="size-3.5" />
            {title}
          </button>
          {hasActions && onActionsContainerChange && (
            <InspectorTabActionsSlot value={tab} onContainerChange={onActionsContainerChange} />
          )}
          {onClose && (
            <button
              type="button"
              aria-label={`Close ${title}`}
              title={`Close ${title}`}
              onClick={(event) => {
                const nav = event.currentTarget.closest("nav")
                onClose()
                requestAnimationFrame(() =>
                  nav
                    ?.querySelector<HTMLButtonElement>(
                      'button[aria-pressed="true"]'
                    )
                    ?.focus()
                )
              }}
              className={cn(
                "grid h-7 w-6 shrink-0 place-items-center rounded-tr-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                value === tab
                  ? "text-background hover:bg-background/15"
                  : "text-foreground-muted hover:bg-muted hover:text-foreground-secondary"
              )}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      {afterTabs}
      {children}
    </nav>
  )
}

function InspectorTabActionsSlot<Value extends string>({ value, onContainerChange }: {
  value: Value
  onContainerChange: (value: Value, container: HTMLDivElement | null) => void
}) {
  const ref = useCallback((container: HTMLDivElement | null) => onContainerChange(value, container), [value, onContainerChange])
  return <div ref={ref} className="flex h-7 w-6 shrink-0 items-center" />
}

export function InspectorTabAction({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} variant="ghost" size="icon-sm" className={cn(
    "h-7 w-6 rounded-none text-foreground-muted hover:bg-muted hover:text-foreground-secondary focus-visible:ring-inset group-data-[active=true]/inspector-tab:text-background group-data-[active=true]/inspector-tab:hover:bg-background/15 group-data-[active=true]/inspector-tab:hover:text-background",
    className
  )} />
}

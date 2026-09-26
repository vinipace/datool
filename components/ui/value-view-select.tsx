"use client"

import * as React from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./base-select"
import {
  isReadOnlyValueView,
  isValueView,
  valueViewLabels,
  type ValueView,
} from "@/src/lib/tracer/value-views"

/** Shared presentation picker for read-only payloads and editable dataset fields. */
export function ValueViewSelect({
  label,
  value,
  views,
  onChange,
  editing = false,
  disabled = false,
}: {
  label: string
  value: ValueView
  views: readonly ValueView[]
  onChange: (view: ValueView) => void
  editing?: boolean
  disabled?: boolean
}) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  const attachTrigger = React.useCallback((element: HTMLElement | null) => {
    // Keep the popup within an enclosing dialog's focus boundary.
    setContainer(element?.closest<HTMLElement>('[role="dialog"]') ?? null)
  }, [])
  const items = views.map((view) => ({
    value: view,
    label: `${valueViewLabels[view]}${editing && isReadOnlyValueView(view) ? " · read only" : ""}`,
  }))
  return (
    <Select
      disabled={disabled}
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next && isValueView(next)) onChange(next)
      }}
    >
      <SelectTrigger
        ref={attachTrigger}
        size="sm"
        variant="ghost"
        aria-label={label}
        className="-mx-1 gap-1 px-1 text-muted-foreground"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        container={container ?? undefined}
        alignItemWithTrigger={false}
      >
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

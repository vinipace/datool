"use client"

import * as React from "react"
import { Combobox } from "@base-ui/react/combobox"
import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  Layers2,
  Plus,
  RotateCcw,
  Save,
  Search,
} from "lucide-react"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"
import { CollectionPageViewSkeleton } from "./collection-skeleton"

type ViewOption = { id: string | null; name: string }

/** Shared Page View selector, including its explicit draft actions. */
export function PageViewMenu({
  options,
  value,
  name,
  dirty,
  loading,
  disabled,
  onSelect,
  onSave,
  onReset,
  onDuplicate,
  onCreateReact,
  onEditReact,
  onCreateMdx,
  onEditMdx,
}: {
  options: ViewOption[]
  value: string | null
  name: string
  dirty: boolean
  loading: boolean
  disabled: boolean
  onSelect: (id: string | null) => void
  onSave: () => void
  onReset: () => void
  onDuplicate: () => void
  onCreateReact?: () => void
  onEditReact?: () => void
  onCreateMdx?: () => void
  onEditMdx?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.id === value) ?? null
  const action = (callback: () => void) => {
    setOpen(false)
    callback()
  }
  if (loading) return <CollectionPageViewSkeleton />
  const rendererActions = [
    { label: "Edit React component", icon: Code2, callback: onEditReact },
    { label: "Edit MDX document", icon: Code2, callback: onEditMdx },
    { label: "Create React Page View", icon: Plus, callback: onCreateReact },
    { label: "Create MDX Page View", icon: Plus, callback: onCreateMdx },
  ]
  return (
    <Combobox.Root
      items={options}
      value={selected}
      open={open}
      onOpenChange={setOpen}
      itemToStringLabel={(option) => option.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={(option) => {
        if (option) onSelect(option.id)
      }}
    >
      <Combobox.Trigger
        render={<Button variant="outline" />}
        disabled={disabled}
        aria-label="Page View"
        aria-description={dirty ? `${name}, unsaved changes` : name}
        className="h-9 max-w-40 min-w-0 shrink gap-1.5 rounded border-border-strong bg-muted px-2 text-xs shadow-none @min-[640px]/page:max-w-64"
      >
        <Layers2 aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
        {dirty && (
          <span
            role="img"
            aria-label="Unsaved changes"
            className="size-1.5 shrink-0 rounded-full bg-warning"
          />
        )}
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 text-foreground-muted"
        />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="z-50">
          <Combobox.Popup
            aria-label="Page Views"
            className="w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            <div
              role="group"
              aria-label="View actions"
              className="flex items-center gap-1 border-b border-border p-1.5"
            >
              {[
                {
                  label: "Duplicate view",
                  icon: Copy,
                  callback: onDuplicate,
                  inactive: disabled,
                },
                {
                  label: "Reset",
                  icon: RotateCcw,
                  callback: onReset,
                  inactive: disabled || !dirty,
                },
              ].map(({ label, icon: Icon, callback, inactive }) => (
                <Tooltip key={label}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6"
                      aria-label={label}
                      disabled={inactive}
                      onClick={() => action(callback)}
                    >
                      <Icon aria-hidden className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              ))}
              <Button
                size="sm"
                className="ml-auto h-6 gap-1 bg-foreground px-2 text-xs text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-foreground-muted disabled:opacity-100"
                aria-label="Save changes"
                disabled={disabled || !dirty}
                onClick={() => action(onSave)}
              >
                <Save aria-hidden className="size-3" />
                Save
              </Button>
            </div>
            <div className="m-1 flex items-center gap-2 rounded bg-muted px-2">
              <Search
                aria-hidden
                className="size-3.5 shrink-0 text-foreground-muted"
              />
              <Combobox.Input
                aria-label="Find a view"
                placeholder="Find a view"
                className="h-8 w-full min-w-0 bg-transparent text-xs outline-none"
              />
            </div>
            <Combobox.Empty>
              <p className="p-3 text-xs text-foreground-muted">
                No views found.
              </p>
            </Combobox.Empty>
            <Combobox.List className="max-h-60 overflow-y-auto p-1">
              {(option: ViewOption) => (
                <Combobox.Item
                  key={option.id ?? "default"}
                  value={option}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="flex size-4 shrink-0 items-center">
                    <Combobox.ItemIndicator>
                      <Check aria-hidden className="size-4" />
                    </Combobox.ItemIndicator>
                  </span>
                  <span className="truncate">{option.name}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
            {rendererActions.some(({ callback }) => callback) && (
              <div className="border-t border-border p-1">
                {rendererActions.map(
                  ({ label, icon: Icon, callback }) =>
                    callback && (
                      <Button
                        key={label}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-xs"
                        disabled={disabled}
                        onClick={() => action(callback)}
                      >
                        <Icon className="size-3.5" />
                        {label}
                      </Button>
                    )
                )}
              </div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}

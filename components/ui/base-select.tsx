"use client"

import { Select as SelectPrimitive } from "@base-ui/react/select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { useOverlayContainer } from "./overlay-container"

const Select = SelectPrimitive.Root

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("min-w-0 truncate", className)}
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  children,
  size = "default",
  variant = "default",
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default"
  variant?: "default" | "ghost"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-md border px-3 text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30",
        size === "sm" ? "h-7 text-xs" : "h-9 text-sm",
        variant === "ghost"
          ? "border-transparent bg-transparent hover:bg-surface-row-hover data-popup-open:bg-surface-row-hover"
          : "border-border bg-background",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />}
      />
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignItemWithTrigger = true,
  container,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignItemWithTrigger"
  > &
  Pick<SelectPrimitive.Portal.Props, "container">) {
  const overlayContainer = useOverlayContainer()
  return (
    <SelectPrimitive.Portal container={container ?? overlayContainer ?? undefined}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className="sticky top-0 z-10 flex justify-center bg-popover py-1">
            <ChevronUp className="size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className="sticky bottom-0 z-10 flex justify-center bg-popover py-1">
            <ChevronDown className="size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }

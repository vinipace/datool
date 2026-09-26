"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-[100] w-80 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type SwitchProps = React.ComponentPropsWithoutRef<
  typeof SwitchPrimitive.Root
> & {
  thumbClassName?: string
}

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, thumbClassName, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    className={cn(
      "inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        "pointer-events-none block size-4 rounded-full bg-foreground shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground",
        thumbClassName
      )}
    />
  </SwitchPrimitive.Root>
))

Switch.displayName = "Switch"

export { Switch, type SwitchProps }

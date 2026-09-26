"use client"

import * as React from "react"
import { Tabs as Primitive } from "radix-ui"
import { cn } from "@/lib/utils"

export const Tabs = Primitive.Root
type TabsVariant = "default" | "panel" | "underline"
const TabsVariantContext = React.createContext<TabsVariant>("default")
const triggerVariants: Record<TabsVariant, string> = {
  default: "h-8 rounded-md data-[state=active]:bg-muted",
  panel:
    "h-full rounded-t-md border border-transparent data-[state=active]:border-border data-[state=active]:border-b-background data-[state=active]:bg-background",
  underline:
    "relative h-12 rounded-none px-1 text-sm font-medium hover:bg-transparent focus-visible:ring-inset after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 data-[state=active]:after:bg-foreground",
}

export function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof Primitive.List> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <Primitive.List
        className={cn(
          "flex shrink-0 items-center gap-1",
          variant === "panel" && "relative top-px h-full items-end gap-0.5",
          variant === "underline" && "-mb-px gap-6",
          className
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  )
}
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext)
  return (
    <Primitive.Trigger
      className={cn(
        "inline-flex items-center justify-center gap-1.5 px-3 text-xs whitespace-nowrap text-foreground-muted outline-none hover:bg-muted hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:shrink-0",
        triggerVariants[variant],
        className
      )}
      {...props}
    />
  )
}
export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content
      className={cn(
        "min-h-0 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
}

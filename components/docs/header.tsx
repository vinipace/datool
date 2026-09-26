"use client"

import type { ComponentProps } from "react"
import { SidebarIcon } from "lucide-react"
import { useDocsLayout } from "fumadocs-ui/layouts/docs"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function DocsHeader({ className, ...props }: ComponentProps<"header">) {
  const { slots, isNavTransparent, props: { nav } } = useDocsLayout()

  return (
    <header
      id="nd-subnav"
      data-transparent={isNavTransparent}
      {...props}
      className={cn(
        "sticky top-(--fd-docs-row-1) z-30 flex h-(--fd-header-height) items-center gap-2 border-b border-border px-2.5 backdrop-blur-sm transition-colors [grid-area:header] max-md:layout:[--fd-header-height:--spacing(14)] md:hidden data-[transparent=false]:bg-background/80",
        className
      )}
    >
      <slots.sidebar.trigger
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <SidebarIcon aria-hidden="true" />
      </slots.sidebar.trigger>
      {slots.navTitle && (
        <slots.navTitle className="inline-flex items-center gap-2.5 font-semibold" />
      )}
      <div className="flex-1">{nav?.children}</div>
      {slots.searchTrigger && (
        <slots.searchTrigger.sm hideIfDisabled className="p-2" />
      )}
    </header>
  )
}

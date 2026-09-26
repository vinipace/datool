"use client"

import * as React from "react"
import { PreviewCard } from "@base-ui/react/preview-card"
import { cn } from "@/lib/utils"
import { useOverlayContainer } from "./overlay-container"

export function HoverCard<Payload>(props: PreviewCard.Root.Props<Payload>) {
  return <PreviewCard.Root {...props} />
}

export function HoverCardTrigger<Payload>(
  props: PreviewCard.Trigger.Props<Payload> & React.RefAttributes<HTMLElement>
) {
  return <PreviewCard.Trigger data-slot="hover-card-trigger" {...props} />
}

export function HoverCardContent({
  className,
  anchor,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof PreviewCard.Popup> &
  Pick<
    React.ComponentProps<typeof PreviewCard.Positioner>,
    "anchor" | "side" | "align" | "sideOffset"
  >) {
  const container = useOverlayContainer()
  return (
    <PreviewCard.Portal container={container ?? undefined}>
      <PreviewCard.Positioner
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-[100]"
      >
        <PreviewCard.Popup
          data-slot="hover-card-content"
          className={cn(
            "w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none",
            className
          )}
          {...props}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  )
}

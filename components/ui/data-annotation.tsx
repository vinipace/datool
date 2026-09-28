import type { ReactElement } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

/** Explain highlighted evidence without adding content to the chart layout. */
export function DataAnnotationTooltip({
  labels,
  children,
  tone,
}: {
  labels: string[]
  children: ReactElement
  tone?: "positive" | "negative" | "neutral"
}) {
  if (!labels.length) return children
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        tabIndex={0}
        className="cursor-help outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        sideOffset={6}
        variant={tone ? "surface" : "default"}
        className={cn(
          "max-w-xs",
          tone && "font-mono tabular-nums",
          tone === "positive" && "text-success",
          tone === "negative" && "text-destructive",
          tone === "neutral" && "text-foreground-muted"
        )}
      >
        <div className="space-y-1">
          {[...new Set(labels)].map((label) => (
            <p key={label}>{label}</p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

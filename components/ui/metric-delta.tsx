import { ArrowDown, ArrowUp, Minus } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

/** Shared good/bad delta styling; arrow direction alone does not imply success. */
export function MetricDelta({
  trend,
  tone,
  children,
  tooltip,
}: {
  trend?: "up" | "down" | "flat"
  tone: "positive" | "negative" | "neutral"
  children: ReactNode
  tooltip?: ReactNode
}) {
  const Icon =
    trend === "up"
      ? ArrowUp
      : trend === "down"
        ? ArrowDown
        : trend === "flat"
          ? Minus
          : null
  const value = (
    <span
      className={cn("inline-flex items-center gap-1 font-medium tabular-nums", {
        "text-success-foreground": tone === "positive",
        "text-destructive": tone === "negative",
        "text-foreground-muted": tone === "neutral",
      })}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
      {tone !== "neutral" && (
        <span className="sr-only">
          {tone === "positive" ? ", improved" : ", worsened"}
        </span>
      )}
    </span>
  )
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto justify-start rounded-sm p-0 text-xs hover:bg-transparent"
        >
          {value}
          <span className="sr-only"> compared with previous period</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-72">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  ) : (
    value
  )
}

import { ArrowDown, ArrowUp, CircleAlert, Equal } from "lucide-react"
import { cn } from "@/lib/utils"

const priorities = {
  low: { label: "Low", icon: ArrowDown, color: "text-foreground-muted" },
  normal: { label: "Normal", icon: Equal, color: "text-info" },
  high: { label: "High", icon: ArrowUp, color: "text-warning" },
  urgent: { label: "Urgent", icon: CircleAlert, color: "text-destructive" },
}

export function PriorityIndicator({
  priority,
  className,
}: {
  priority?: string | null
  className?: string
}) {
  const entry =
    priority && Object.hasOwn(priorities, priority)
      ? priorities[priority as keyof typeof priorities]
      : null
  if (!entry)
    return <span className="text-foreground-muted">{priority || "—"}</span>
  const Icon = entry.icon
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Icon className={cn("size-3.5 shrink-0", entry.color)} aria-hidden />
      <span>{entry.label}</span>
    </span>
  )
}

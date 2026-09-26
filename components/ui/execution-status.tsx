import {
  Check,
  CircleAlert,
  Clock3,
  Loader,
  LoaderCircle,
  Minus,
  TriangleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"

export function RunningSpinner() {
  return (
    <Loader
      role="img"
      aria-label="Running"
      className="size-3.5 shrink-0 text-foreground-muted motion-safe:animate-spin"
    />
  )
}

const states = {
  queued: { icon: Clock3, label: "Queued", style: "text-foreground-muted" },
  running: { icon: LoaderCircle, label: "Running", style: "text-info" },
  completed: { icon: Check, label: "Completed", style: "text-success" },
  error: { icon: CircleAlert, label: "Error", style: "text-destructive" },
  skipped: { icon: Minus, label: "Skipped", style: "text-foreground-muted" },
  partial: { icon: TriangleAlert, label: "Partial", style: "text-warning" },
}

export function ExecutionStatus({
  status,
  label,
  className,
}: {
  status: keyof typeof states
  label?: string
  className?: string
}) {
  const { icon: Icon, label: defaultLabel, style } = states[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        style,
        className
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          status === "running" && "motion-safe:animate-spin"
        )}
      />
      <span>{label ?? defaultLabel}</span>
    </span>
  )
}

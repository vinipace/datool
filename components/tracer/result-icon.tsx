import { Check, X } from "lucide-react"

import { cn } from "@/lib/utils"

export function ResultIcon({
  success,
  label = success ? "Passed" : "Failed",
}: {
  success: boolean
  label?: string
}) {
  const Icon = success ? Check : X

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle",
        success
          ? "bg-status-success text-status-success-foreground"
          : "bg-destructive text-status-error-foreground"
      )}
    >
      <Icon aria-hidden="true" className="size-3" strokeWidth={3} />
    </span>
  )
}

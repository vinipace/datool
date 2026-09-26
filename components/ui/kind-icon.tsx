import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function KindIcon({
  icon: Icon,
  label,
  className,
}: {
  icon: LucideIcon
  label?: string
  className?: string
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={cn(
        "relative flex size-5 flex-none items-center justify-center rounded-[3px]",
        !label && "pointer-events-none",
        className
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
    </span>
  )
}

import { cn } from "@/lib/utils"

export function PieProgress({
  value,
  max,
  label,
  className,
}: {
  value: number
  max: number
  label: string
  className?: string
}) {
  const total = Number.isFinite(max) && max > 0 ? max : 1
  const current = Math.min(
    total,
    Math.max(0, Number.isFinite(value) ? value : 0)
  )
  const fraction = current / total
  const angle = fraction * Math.PI * 2
  const x = 8 + 6 * Math.sin(angle)
  const y = 8 - 6 * Math.cos(angle)

  return (
    <svg
      viewBox="0 0 16 16"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      className={cn("size-4 shrink-0 text-foreground-muted", className)}
    >
      <circle cx="8" cy="8" r="7" fill="none" className="stroke-current" />
      {fraction === 1 ? (
        <circle cx="8" cy="8" r="6" className="fill-current" />
      ) : fraction > 0 ? (
        <path
          d={`M 8 8 L 8 2 A 6 6 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`}
          className="fill-current"
        />
      ) : null}
    </svg>
  )
}

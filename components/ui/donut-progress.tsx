import { cn } from "@/lib/utils"

export function DonutProgress({
  value,
  max,
  label,
  segments,
  className,
  valueText,
  trackClassName,
}: {
  value: number
  max: number
  label: string
  segments: { label: string; value: number; className: string }[]
  className?: string
  valueText?: string
  trackClassName?: string
}) {
  const total = Math.max(0, max)
  const current = Math.min(total, Math.max(0, value))
  const percentage = total ? Math.round((current / total) * 100) : 0
  const slices = segments.filter((segment) => segment.value > 0)
  let offset = 0

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total || 1}
      aria-valuenow={current}
      aria-valuetext={
        valueText ??
        (total
          ? `${percentage}% finished (${current} of ${total})`
          : "No scorer runs")
      }
      className={cn("relative size-20 shrink-0", className)}
    >
      <svg
        viewBox="0 0 100 100"
        aria-hidden="true"
        className="size-full -rotate-90"
      >
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          strokeWidth="8"
          className={cn("stroke-current text-muted", trackClassName)}
        />
        {total > 0 &&
          slices.map((segment) => {
            const start = offset
            const share = Math.min(100 - start, (segment.value / total) * 100)
            offset += share
            return (
              <circle
                key={segment.label}
                cx="50"
                cy="50"
                r="42"
                fill="none"
                strokeWidth="8"
                pathLength="100"
                strokeDasharray={
                  share === 100
                    ? undefined
                    : `${Math.max(0, share - (slices.length > 1 ? Math.min(1, share / 4) : 0))} 100`
                }
                strokeDashoffset={-start}
                className={cn("stroke-current", segment.className)}
              />
            )
          })}
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-base font-medium tabular-nums"
      >
        {percentage}%
      </span>
    </div>
  )
}

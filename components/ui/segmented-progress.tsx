import { cn } from "@/lib/utils"

export function SegmentedProgress({
  value,
  max,
  label,
  segments,
  className,
  valueText,
  variant = "solid",
}: {
  value: number
  max: number
  label: string
  segments: { label: string; value: number; className: string }[]
  className?: string
  valueText?: string
  variant?: "solid" | "dashed"
}) {
  const total = Math.max(0, max)
  const current = Math.min(total, Math.max(0, value))
  let remaining = 100

  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total || 1}
      aria-valuenow={current}
      aria-valuetext={
        valueText ??
        (total ? `${current} of ${total} finished` : "No scorer runs")
      }
      className={cn(
        "flex h-1 w-full overflow-hidden",
        variant === "dashed" ? "gap-1" : "rounded-full bg-muted",
        className
      )}
    >
      {variant === "dashed"
        ? Array.from({ length: 40 }, (_, index) => {
            const point = ((index + 0.5) / 40) * total
            let cumulative = 0
            const segment =
              total > 0
                ? segments.find((entry) => {
                    cumulative += Math.max(0, entry.value)
                    return point < cumulative
                  })
                : undefined
            return (
              <span
                aria-hidden="true"
                key={index}
                className={cn(
                  "h-full min-w-0 flex-1 rounded-sm",
                  segment ? ["bg-current", segment.className] : "bg-border"
                )}
              />
            )
          })
        : total > 0 &&
          segments
            .filter((segment) => segment.value > 0)
            .map((segment) => {
              const width = Math.min(remaining, (segment.value / total) * 100)
              remaining -= width
              return (
                <span
                  key={segment.label}
                  aria-hidden="true"
                  className={cn(
                    "h-full shrink-0 bg-current",
                    segment.className
                  )}
                  style={{ width: `${width}%` }}
                />
              )
            })}
    </span>
  )
}

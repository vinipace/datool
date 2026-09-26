const fillClasses = {
  neutral: "bg-score-fill",
  destructive: "bg-destructive",
  success: "bg-success",
}

export function PercentageCell({
  value,
  tone = "neutral",
}: {
  value: number | null | undefined
  tone?: keyof typeof fillClasses
}) {
  if (value == null || !Number.isFinite(value)) {
    return (
      <span data-empty="true" className="text-empty-foreground">
        —
      </span>
    )
  }

  const percentage = Math.min(100, Math.max(0, value * 100))
  return (
    <span data-slot="percentage-cell" className="inline-flex w-20 flex-col gap-1 align-middle">
      <span className="tabular-nums">
        {(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
      </span>
      <span
        aria-hidden="true"
        className="h-0.5 w-full overflow-hidden rounded-full bg-score-track"
      >
        <span
          className={`block h-full rounded-full ${fillClasses[tone]}`}
          style={{ width: `${percentage}%` }}
        />
      </span>
    </span>
  )
}

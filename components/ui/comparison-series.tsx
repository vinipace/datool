import { cn } from "@/lib/utils"

const series = [
  {
    dot: "bg-comparison-1",
    row: "bg-comparison-1/10 hover:bg-comparison-1/15",
  },
  {
    dot: "bg-comparison-2",
    row: "bg-comparison-2/10 hover:bg-comparison-2/15",
  },
  {
    dot: "bg-comparison-3",
    row: "bg-comparison-3/10 hover:bg-comparison-3/15",
  },
  {
    dot: "bg-comparison-4",
    row: "bg-comparison-4/10 hover:bg-comparison-4/15",
  },
]

// eslint-disable-next-line react-refresh/only-export-components
export function comparisonRowClass(index: number) {
  return series[index % series.length].row
}

export function ComparisonDot({
  index,
  className,
}: {
  index: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        series[index % series.length].dot,
        className
      )}
    />
  )
}

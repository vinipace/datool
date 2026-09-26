import { formatTraceTimestamp } from "./trace-list-utils"

export function LogTimestamp({ value }: { value: string }) {
  return (
    <span
      className="text-sm whitespace-nowrap text-foreground-secondary tabular-nums"
      title={value}
    >
      {formatTraceTimestamp(value)}
    </span>
  )
}

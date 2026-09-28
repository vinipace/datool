import { cn } from "@/lib/utils"

const tones = [
  "bg-comparison-1",
  "bg-comparison-2",
  "bg-comparison-3",
  "bg-comparison-4",
  "bg-comparison-5",
  "bg-comparison-6",
]
const dimensionTones: Record<string, number> = {
  groupName: 0,
  promptVersion: 1,
  evaluatorName: 2,
  datasetId: 3,
  promptId: 4,
  evaluatorVersion: 5,
}

/** The legend and values share a stable color for each dimension across widgets. */
export function DimensionLabel({
  field,
  label,
  value,
}: {
  field: string
  label: string
  value?: string
}) {
  const key = field.split(".").at(-1) ?? field
  const tone =
    dimensionTones[key] ??
    [...key].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) %
      tones.length
  return (
    <span
      data-field={field}
      title={value === undefined ? label : `${label}: ${value}`}
      className={cn(
        "inline-flex max-w-full items-stretch gap-2 text-xs font-normal",
        value === undefined ? "text-foreground-muted" : "text-foreground"
      )}
    >
      <span
        aria-hidden="true"
        className={cn("my-0.5 w-0.5 shrink-0 rounded-full", tones[tone])}
      />
      <span className="min-w-0 break-words">{value ?? label}</span>
    </span>
  )
}

"use client"

import {
  Archive,
  CircleCheck,
  CircleDot,
  Clock3,
  ListFilter,
  Moon,
} from "lucide-react"
import {
  SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const statuses = {
  open: { label: "Open", icon: CircleDot, color: "text-info" },
  pending: { label: "Pending", icon: Clock3, color: "text-warning" },
  snoozed: { label: "Snoozed", icon: Moon, color: "text-status-snoozed" },
  solved: { label: "Solved", icon: CircleCheck, color: "text-success" },
  closed: { label: "Closed", icon: Archive, color: "text-foreground-muted" },
}
const allStatuses = {
  label: "All statuses",
  icon: ListFilter,
  color: "text-foreground-muted",
}
const statusOptions = Object.entries(statuses).map(([value, { label }]) => ({
  value,
  label,
}))

function statusEntry(status?: string | null) {
  return status && Object.hasOwn(statuses, status)
    ? statuses[status as keyof typeof statuses]
    : null
}

function TicketStatusIcon({ status }: { status?: string | null }) {
  const entry = status === "" ? allStatuses : statusEntry(status)
  if (!entry) return null
  const Icon = entry.icon
  return <Icon className={`size-3.5 shrink-0 ${entry.color}`} aria-hidden />
}

export function TicketStatusIndicator({ status }: { status?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TicketStatusIcon status={status} />
      <span>{statusEntry(status)?.label ?? status ?? "—"}</span>
    </span>
  )
}

export function TicketStatusSelect({
  value,
  onValueChange,
  disabled,
  includeAll = false,
  label,
}: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  includeAll?: boolean
  label: string
}) {
  const options = includeAll
    ? [{ value: "", label: allStatuses.label }, ...statusOptions]
    : statusOptions
  return (
    <SelectRoot
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next)
      }}
      disabled={disabled}
      items={options}
    >
      <SelectTrigger aria-label={label} size="sm" className="h-8 shrink-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <TicketStatusIcon status={value} />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-2">
              <TicketStatusIcon status={option.value} />
              <span>{option.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

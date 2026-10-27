"use client"

import {
  CircleCheck,
  CircleDot,
  CircleHelp,
  ListFilter,
  ShieldBan,
  UserRound,
} from "lucide-react"

import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

const statuses = {
  active: { label: "Ongoing", icon: CircleDot, color: "text-info" },
  handed_off: { label: "Taken over", icon: UserRound, color: "text-warning" },
  closed: { label: "Ended", icon: CircleCheck, color: "text-success" },
  blocked: { label: "Blocked", icon: ShieldBan, color: "text-destructive" },
}

const conversationStatusOptions = [
  { value: "", label: "All statuses" },
  ...Object.entries(statuses).map(([value, { label }]) => ({ value, label })),
]

export function ConversationStatusBadge({
  status = "active",
}: {
  status?: string | null
}) {
  const entry =
    status === ""
      ? {
          label: "All statuses",
          icon: ListFilter,
          color: "text-foreground-muted",
        }
      : status && Object.hasOwn(statuses, status)
        ? statuses[status as keyof typeof statuses]
        : {
            label: status || "Unknown",
            icon: CircleHelp,
            color: "text-foreground-muted",
          }
  const Icon = entry.icon
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${entry.color}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{entry.label}</span>
    </span>
  )
}

export function ConversationStatusSelect({
  value,
  onValueChange,
}: {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <SelectRoot
      value={value}
      items={conversationStatusOptions}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next)
      }}
    >
      <SelectTrigger aria-label="Conversation status" size="sm">
        <SelectValue>
          <ConversationStatusBadge status={value} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {conversationStatusOptions.map(({ value }) => (
          <SelectItem key={value} value={value}>
            <ConversationStatusBadge status={value} />
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

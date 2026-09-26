"use client"

import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./base-select"
import { useOverlayContainer } from "./overlay-container"

const roles = {
  owner: {
    label: "Owner",
    color: "border-warning/30 bg-warning/10 text-warning",
  },
  admin: { label: "Admin", color: "border-info/30 bg-info/10 text-info" },
  member: {
    label: "Member",
    color: "border-success/30 bg-success/10 text-success",
  },
}

export function OrganizationRoleBadge({ role }: { role: string }) {
  const appearance = roles[role as keyof typeof roles]
  return (
    <span
      data-slot="organization-role-badge"
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-xs font-medium",
        appearance?.color ?? "border-border bg-muted text-foreground"
      )}
    >
      {appearance?.label ?? role}
    </span>
  )
}

export function OrganizationRoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: "member" | "admin"
  onChange: (value: "member" | "admin") => void
  disabled?: boolean
}) {
  const container = useOverlayContainer()
  return (
    <Select
      value={value}
      disabled={disabled}
      items={[
        { value: "member", label: "Member" },
        { value: "admin", label: "Admin" },
      ]}
      onValueChange={(next) => {
        if (next === "member" || next === "admin") onChange(next)
      }}
    >
      <SelectTrigger aria-label="Role" className="w-full">
        <SelectValue>
          <OrganizationRoleBadge role={value} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        container={container ?? undefined}
        alignItemWithTrigger={false}
      >
        <SelectItem value="member">
          <OrganizationRoleBadge role="member" />
        </SelectItem>
        <SelectItem value="admin">
          <OrganizationRoleBadge role="admin" />
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

"use client"

import { UsersRound } from "lucide-react"
import { ComboboxMultiple } from "./combobox"
import { UserAvatarImage } from "./user-avatar"

export type ReviewerOption = {
  id: string
  name: string
  image: string | null
  email?: string
}

/** Controlled reviewer selection; assignment persistence belongs to the caller. */
export function ReviewerCombobox({
  reviewers,
  value,
  onValueChange,
  disabled,
  label = "Reviewers",
}: {
  reviewers: ReviewerOption[]
  value: string[]
  onValueChange: (ids: string[]) => void
  disabled?: boolean
  label?: string
}) {
  const selected = value.flatMap((id) => {
    const reviewer = reviewers.find((reviewer) => reviewer.id === id)
    return reviewer ? [reviewer] : []
  })
  return (
    <ComboboxMultiple
      label={label}
      options={reviewers.map((reviewer) => ({
        value: reviewer.id,
        label: reviewer.name,
        description: reviewer.email,
        descriptionBelow: true,
        keywords: reviewer.email ? [reviewer.email] : [],
        leading: (
          <UserAvatarImage name={reviewer.name} image={reviewer.image} />
        ),
      }))}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      maxSelected={50}
      popupClassName="w-72"
      triggerContent={
        <>
          <span className="sr-only">
            {selected.length
              ? selected.map((reviewer) => reviewer.name).join(", ")
              : "Unassigned"}
          </span>
          <span aria-hidden="true" className="flex items-center -space-x-2">
            {selected.slice(0, 3).map((reviewer) => (
              <UserAvatarImage
                key={reviewer.id}
                name={reviewer.name}
                image={reviewer.image}
              />
            ))}
            {!selected.length && (
              <UsersRound className="size-4 text-foreground-muted" />
            )}
          </span>
          {selected.length > 3 && (
            <span aria-hidden="true" className="text-xs text-foreground-muted">
              +{selected.length - 3}
            </span>
          )}
        </>
      }
    />
  )
}

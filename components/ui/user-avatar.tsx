"use client"

import { Avatar as AvatarPrimitive } from "radix-ui"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

export function UserAvatar({
  name,
  image,
  label = name,
}: {
  name: string
  image: string | null
  label?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={label}
        className="shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <UserAvatarImage name={name} image={image} />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Non-interactive avatar for use inside buttons and option rows. */
export function UserAvatarImage({
  name,
  image,
}: {
  name: string
  image: string | null
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
  return (
    <AvatarPrimitive.Root
      data-slot="user-avatar"
      className="flex size-7 shrink-0 overflow-hidden rounded-full border border-border bg-muted"
    >
      <AvatarPrimitive.Image
        src={image ?? undefined}
        referrerPolicy="no-referrer"
        alt=""
        className="size-full object-cover"
      />
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center text-xs font-medium text-foreground-muted">
        {initials || "?"}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

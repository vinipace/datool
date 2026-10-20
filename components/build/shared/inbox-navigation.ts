"use client"

import { usePathname, useSearchParams } from "next/navigation"
import {
  AtSign,
  CircleCheck,
  Inbox,
  Layers,
  UserRoundMinus,
} from "lucide-react"

export const inboxViews = [
  { id: "mine", label: "My Inbox", icon: Inbox },
  { id: "mentions", label: "Mentions", icon: AtSign },
  { id: "all", label: "All", icon: Layers },
  { id: "unassigned", label: "Unassigned", icon: UserRoundMinus },
  { id: "solved", label: "Solved", icon: CircleCheck },
] as const

export function useInboxNavigation() {
  const pathname = usePathname()
  const params = useSearchParams()
  const view =
    inboxViews.find((item) => item.id === params.get("view"))?.id ?? "all"
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    return `${pathname}${next.size ? `?${next}` : ""}`
  }
  return {
    view,
    params,
    href,
    navigate(changes: Record<string, string | null>, replace = false) {
      window.history[replace ? "replaceState" : "pushState"](
        null,
        "",
        href(changes)
      )
    },
  }
}

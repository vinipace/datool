"use client"

import * as React from "react"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { ChatNavigationContext } from "./chat-navigation-context"

/** Store links leave the embedded chat; other links open separately. */
export function ChatLink({
  href,
  children,
}: React.PropsWithChildren<{ href?: string }>) {
  const navigation = React.useContext(ChatNavigationContext)
  if (!href) return <a>{children}</a>
  if (!navigation) return <a href={href}>{children}</a>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          isSafeHttpUrl(href) &&
          navigation.navigate(href)
        )
          event.preventDefault()
      }}
    >
      {children}
    </a>
  )
}

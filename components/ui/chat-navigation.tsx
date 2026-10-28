"use client"

import * as React from "react"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { ChatNavigationContext } from "./chat-navigation-context"

/** Store links leave the embedded chat; other links open separately. */
export function ChatLink({
  href,
  children,
  onClick,
  ...props
}: React.ComponentPropsWithRef<"a">) {
  const navigation = React.useContext(ChatNavigationContext)
  if (!href)
    return (
      <a {...props} onClick={onClick}>
        {children}
      </a>
    )
  if (!navigation)
    return (
      <a {...props} href={href} onClick={onClick}>
        {children}
      </a>
    )
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        onClick?.(event)
        if (
          !event.defaultPrevented &&
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

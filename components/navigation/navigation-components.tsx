"use client"

import * as React from "react"
import {
  NavigationContext,
  useNavigationAdapter,
  type LinkProps,
  type NavigationAdapter,
} from "./navigation-context"

export function NavigationProvider({
  adapter,
  children,
}: React.PropsWithChildren<{ adapter: NavigationAdapter }>) {
  return (
    <NavigationContext.Provider value={adapter}>
      {children}
    </NavigationContext.Provider>
  )
}
/** Next keeps its Link implementation; embedded hosts handle local routes themselves. */
export function NavigationLink({
  href,
  replace,
  scroll,
  prefetch,
  onClick,
  ...props
}: LinkProps) {
  const adapter = useNavigationAdapter()
  const resolved = adapter.resolveHref?.(href) ?? href
  if (adapter.Link) {
    const Link = adapter.Link
    return (
      <Link
        {...props}
        href={resolved}
        replace={replace}
        scroll={scroll}
        prefetch={prefetch}
        onClick={onClick}
      />
    )
  }
  return (
    <a
      {...props}
      href={resolved}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.download ||
          (props.target && props.target !== "_self")
        )
          return
        if (adapter.canNavigate?.(href)) {
          event.preventDefault()
          adapter.router[replace ? "replace" : "push"](href, { scroll })
        } else if (adapter.openExternal && resolved !== "#") {
          event.preventDefault()
          adapter.openExternal(resolved)
        }
      }}
    />
  )
}

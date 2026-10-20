"use client"

import * as React from "react"

export type NavigationOptions = { scroll?: boolean }
export type ReadonlyURLSearchParams = Omit<
  URLSearchParams,
  "append" | "delete" | "set" | "sort"
>
export type NavigationRouter = {
  push: (href: string, options?: NavigationOptions) => void
  replace: (href: string, options?: NavigationOptions) => void
  /** Update filters without requesting another server-rendered page. */
  replaceQuery: (href: string) => void
  back: () => void
  forward: () => void
  refresh: () => void
  prefetch: (href: string) => void
}
export type LinkProps = React.ComponentPropsWithRef<"a"> & {
  href: string
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean
}
export type NavigationAdapter = {
  origin?: string
  router: NavigationRouter
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => string
  getServerSnapshot: () => string
  resolveHref?: (href: string) => string
  canNavigate?: (href: string) => boolean
  openExternal?: (href: string) => void
  Link?: React.ComponentType<LinkProps>
}
export const NavigationContext = React.createContext<NavigationAdapter | null>(
  null
)
const browserEvent = "datool:navigation"
function browserUrl() {
  return typeof window === "undefined"
    ? "/"
    : `${window.location.pathname}${window.location.search}${window.location.hash}`
}
export function subscribeBrowserNavigation(listener: () => void) {
  window.addEventListener("popstate", listener)
  window.addEventListener(browserEvent, listener)
  return () => {
    window.removeEventListener("popstate", listener)
    window.removeEventListener(browserEvent, listener)
  }
}
export function replaceBrowserQuery(href: string) {
  window.history.replaceState(null, "", internalUrl(href))
  window.dispatchEvent(new Event(browserEvent))
}
function internalUrl(href: string) {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\"))
    throw new Error("Navigation requires a same-origin path.")
  const url = new URL(href, "https://navigation.invalid")
  if (url.origin !== "https://navigation.invalid")
    throw new Error("Invalid navigation origin.")
  return `${url.pathname}${url.search}${url.hash}`
}
// Native navigation remains useful for standalone previews and unwrapped links.
// The product shell supplies Next; the plugin supplies its own history adapter.
const browserAdapter: NavigationAdapter = {
  subscribe: subscribeBrowserNavigation,
  getSnapshot: browserUrl,
  getServerSnapshot: () => "/",
  router: {
    push: (href) => window.location.assign(internalUrl(href)),
    replace: (href) => window.location.replace(internalUrl(href)),
    replaceQuery: replaceBrowserQuery,
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => window.location.reload(),
    prefetch: () => {},
  },
}

export function useNavigationAdapter() {
  return React.useContext(NavigationContext) ?? browserAdapter
}

export function useNavigation() {
  const adapter = useNavigationAdapter()
  const url = React.useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getServerSnapshot
  )
  const parsed = React.useMemo(
    () => new URL(url, "https://navigation.invalid"),
    [url]
  )
  return React.useMemo(
    () => ({
      pathname: parsed.pathname,
      searchParams: parsed.searchParams as ReadonlyURLSearchParams,
      hash: parsed.hash,
      origin: adapter.origin,
      router: adapter.router,
      currentUrl: adapter.getSnapshot,
      resolveHref: adapter.resolveHref ?? ((href: string) => href),
    }),
    [adapter, parsed]
  )
}
export const usePathname = () => useNavigation().pathname
export const useSearchParams = () => useNavigation().searchParams
export const useRouter = () => useNavigation().router

/** Embedded navigation never changes the ChatGPT page or escapes its own history. */
export function createMemoryNavigation(
  initialUrl: string,
  {
    origin,
    accepts,
    openExternal,
  }: {
    origin?: string
    accepts?: (pathname: string) => boolean
    openExternal?: (href: string) => void
  } = {}
): NavigationAdapter {
  const initial = internalUrl(initialUrl)
  const history = [initial]
  let index = 0
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach((listener) => listener())
  const canNavigate = (href: string) => {
    try {
      return (
        accepts?.(
          new URL(internalUrl(href), "https://navigation.invalid").pathname
        ) ?? true
      )
    } catch {
      return false
    }
  }
  const navigate = (href: string, replace: boolean) => {
    if (!canNavigate(href))
      throw new Error(
        "This page is available in Datool. Open its website link."
      )
    const url = internalUrl(href)
    if (replace) history[index] = url
    else {
      history.splice(index + 1)
      history.push(url)
      index++
    }
    publish()
  }
  return {
    origin,
    openExternal,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => history[index],
    getServerSnapshot: () => initial,
    canNavigate,
    resolveHref: (href) => {
      if (canNavigate(href) || !origin) return href
      const url = new URL(href, origin)
      return ["http:", "https:"].includes(url.protocol) ? url.href : "#"
    },
    router: {
      push: (href) => navigate(href, false),
      replace: (href) => navigate(href, true),
      replaceQuery: (href) => navigate(href, true),
      back: () => {
        if (index > 0) {
          index--
          publish()
        }
      },
      forward: () => {
        if (index < history.length - 1) {
          index++
          publish()
        }
      },
      refresh: publish,
      prefetch: () => {},
    },
  }
}

"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  NavigationProvider,
  replaceBrowserQuery,
  subscribeBrowserNavigation,
  type NavigationAdapter,
} from "./navigation"

/** This is the only Next-specific adapter used by the shared trace components. */
export function NextNavigationProvider({ children }: React.PropsWithChildren) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const url = search ? `${pathname}?${search}` : pathname
  const adapter = React.useMemo<NavigationAdapter>(
    () => ({
      router: { ...router, replaceQuery: replaceBrowserQuery },
      subscribe: subscribeBrowserNavigation,
      getSnapshot: () => url,
      getServerSnapshot: () => url,
      Link,
    }),
    [router, url]
  )
  return <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
}

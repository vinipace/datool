"use client"

import * as React from "react"
import { useNavigation } from "@/components/navigation/navigation"
import {
  compileCollectionFilter,
  type FilterResource,
} from "@/src/lib/tracer/collection-filters"

export function useCollectionFilter(
  resource: FilterResource,
  initialValue = "",
  {
    persist = true,
    normalize = (value: string) => value,
  }: { persist?: boolean; normalize?: (value: string) => string } = {}
) {
  const navigation = useNavigation()
  const { pathname, searchParams } = navigation
  const urlFilter = persist ? searchParams.get("filter") : null
  const source = JSON.stringify([pathname, urlFilter])
  const initial = normalize(urlFilter ?? initialValue)
  const [state, setState] = React.useState({
    source,
    value: initial,
    filter: initial,
    pending: false,
  })
  // Navigation is authoritative, including Back/Forward on the same page.
  // Reset before committing so an old debounce cannot overwrite the new URL.
  if (state.source !== source) {
    setState({ source, value: initial, filter: initial, pending: false })
  }
  const { value, filter } = state
  const error = React.useMemo(() => {
    try {
      compileCollectionFilter(resource, value)
      return null
    } catch (reason) {
      return reason instanceof Error ? reason.message : "Invalid filter."
    }
  }, [resource, value])

  React.useEffect(() => {
    if (error || !state.pending) return
    const scheduledUrl = new URL(navigation.currentUrl(), "https://navigation.invalid")
    const timer = window.setTimeout(
      () => {
        if (persist) {
          const url = new URL(navigation.currentUrl(), "https://navigation.invalid")
          // Read the latest URL so inspector selections and other params survive.
          if (
            url.pathname !== scheduledUrl.pathname ||
            url.searchParams.get("filter") !==
              scheduledUrl.searchParams.get("filter")
          )
            return
          // An explicit empty value overrides defaults such as the dashboard date.
          url.searchParams.set("filter", value.trim())
          navigation.router.replaceQuery(`${url.pathname}${url.search}${url.hash}`)
        }
        setState((current) => ({
          ...current,
          filter: value.trim(),
          pending: false,
        }))
      },
      value ? 350 : 0
    )
    return () => window.clearTimeout(timer)
  }, [error, value, state.pending, pathname, persist, urlFilter, navigation])

  const onChange = (next: string) => {
    setState((current) => ({
      ...current,
      value: normalize(next),
      pending: true,
    }))
  }

  return { value, onChange, filter, error }
}

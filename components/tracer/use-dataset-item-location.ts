"use client"

import { useCallback, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import {
  readDatasetItemLocation,
  writeDatasetItemLocation,
  type DatasetItemLocation,
} from "@/src/lib/tracer/dataset-item-location"

import { useWorkspaceHref } from "./workspace-path"

export function useDatasetItemLocation(datasetId: string) {
  const pathname = usePathname()
  const datasetPath = useWorkspaceHref()(`/datasets/${encodeURIComponent(datasetId)}`)
  const search = useSearchParams()
  const query = search?.toString() ?? ""
  const source = `${pathname}?${query}`
  const [state, setState] = useState(() => ({ source, location: readDatasetItemLocation(pathname, new URLSearchParams(query)) }))
  // Keep back/forward and links authoritative, with immediate feedback on local clicks.
  if (state.source !== source) {
    setState({ source, location: readDatasetItemLocation(pathname, new URLSearchParams(query)) })
  }
  const update = useCallback((patch: Partial<DatasetItemLocation>, replace = false) => {
    const url = new URL(window.location.href)
    const location = { ...readDatasetItemLocation(url.pathname, url.searchParams), ...patch }
    const next = writeDatasetItemLocation(datasetPath, url.searchParams, location)
    url.pathname = next.pathname
    url.search = next.search
    if (url.href !== window.location.href) {
      window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`)
    }
    setState(current => ({ ...current, location }))
  }, [datasetPath])
  return { ...state.location, update }
}

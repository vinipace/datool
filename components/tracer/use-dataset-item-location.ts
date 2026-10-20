"use client"

import { useCallback, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import {
  readDatasetItemLocation,
  writeDatasetItemLocation,
  type DatasetItemLocation,
} from "@/src/lib/tracer/dataset-item-location"

import { useWorkspaceHref } from "./workspace-path"

export function useDatasetItemLocation(datasetId: string, embedded = false) {
  const pathname = usePathname()
  const standalonePath = useWorkspaceHref()(`/datasets/${encodeURIComponent(datasetId)}`)
  const datasetPath = embedded ? pathname : standalonePath
  const search = useSearchParams()
  const query = search?.toString() ?? ""
  const source = `${pathname}?${query}`
  const [state, setState] = useState(() => ({ source, location: readDatasetItemLocation(pathname, new URLSearchParams(query), embedded) }))
  // Keep back/forward and links authoritative, with immediate feedback on local clicks.
  if (state.source !== source) {
    setState({ source, location: readDatasetItemLocation(pathname, new URLSearchParams(query), embedded) })
  }
  const update = useCallback((patch: Partial<DatasetItemLocation>, replace = false) => {
    const url = new URL(window.location.href)
    const location = { ...readDatasetItemLocation(url.pathname, url.searchParams, embedded), ...patch }
    const next = writeDatasetItemLocation(datasetPath, url.searchParams, location, embedded)
    url.pathname = next.pathname
    url.search = next.search
    if (url.href !== window.location.href) {
      window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`)
    }
    setState(current => ({ ...current, location }))
  }, [datasetPath, embedded])
  return { ...state.location, update }
}

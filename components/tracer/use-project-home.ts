"use client"

import { useRef, useState } from "react"
import type { ProjectHome } from "@/src/lib/tracer/project-home"
import { useRemote } from "./hooks"
import { dashboardRequest } from "./dashboard-utils"
import { useProjectScope } from "./project-scope-context"

export function useProjectHome() {
  const projectId = useProjectScope()?.projectId
  const [saved, setSaved] = useState<{
    projectId?: string
    home: ProjectHome
  } | null>(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState("")
  const state = useRemote(
    (signal) =>
      dashboardRequest<ProjectHome>("/api/project-home", "GET", undefined, {
        signal,
        projectId,
      }),
    [projectId]
  )
  const home =
    saved?.projectId === projectId &&
    saved &&
    saved.home.revision >= (state.data?.revision ?? 0)
      ? saved.home
      : state.data
  async function mutate(method: string, body?: unknown, id?: string) {
    if (busy.current) return null
    busy.current = true
    setPending(true)
    setError("")
    try {
      const home = await dashboardRequest<ProjectHome>(
        `/api/project-home${id ? `?id=${encodeURIComponent(id)}` : ""}`,
        method,
        body,
        { projectId }
      )
      setSaved({ projectId, home })
      return home
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to update Home."
      )
      return null
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return {
    home,
    pending,
    error,
    state,
    refresh() {
      setSaved(null)
      setError("")
      state.refresh()
    },
    pin: (dashboardId: string, widgetId: string) =>
      mutate("POST", { dashboardId, widgetId }),
    unpin: (id: string) => mutate("DELETE", undefined, id),
    saveLayout: (layout: unknown, expectedRevision: number) =>
      mutate("PATCH", { layout, expectedRevision }),
  }
}

"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import type { Dashboard } from "@/src/lib/tracer/dashboards"
import { createDashboardAutosave } from "@/src/lib/tracer/dashboard-autosave"
import { useProjectScope } from "./project-scope-context"
import { dashboardRequest } from "./dashboard-utils"

export function useDashboardAutosave(dashboard: Dashboard) {
  const project = useProjectScope()
  const [store] = useState(() =>
    createDashboardAutosave({
      initial: dashboard,
      save: (config, expectedRevision) =>
        dashboardRequest<Dashboard>(
          `/api/dashboards/${encodeURIComponent(dashboard.id)}`,
          "PATCH",
          { config, expectedRevision },
          // An in-flight save must keep its original project if the route changes.
          { projectId: project?.projectId }
        ),
    })
  )
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (store.pending()) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      if (store.pending() && !store.getSnapshot().error)
        void store.flush().catch(() => {})
    }
  }, [store])
  return {
    ...state,
    update: store.update,
    retry: store.flush,
    pending: store.pending(),
  }
}

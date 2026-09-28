"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { callViewOperation } from "./view-library-client"
type Preference = { revision: number; value: Record<string, unknown> }

/** Writes are serialized with CAS. A conflict preserves the caller's local draft. */
export function useViewPreference(projectId: string, scope: string) {
  const [state, setState] = useState<{ key: string; preference?: Preference; error?: string }>({ key: "" })
  const key = projectId + ":" + scope
  const session = useRef({ key, revision: 0, last: "", stopped: false, chain: Promise.resolve() })
  useEffect(() => {
    const current = { key, revision: 0, last: "", stopped: false, chain: Promise.resolve() }
    session.current = current
    if (!projectId || !scope) return
    const controller = new AbortController()
    void callViewOperation<Preference>(projectId, "get_view_preference", { scope }, controller.signal).then(preference => {
      if (controller.signal.aborted) return
      current.revision = preference.revision
      current.last = JSON.stringify(preference.value)
      setState({ key, preference })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, error: String(error) })
    })
    return () => { controller.abort(); current.stopped = true }
  }, [key, projectId, scope])
  const save = useCallback((value: Record<string, unknown>) => {
    const current = session.current
    const serialized = JSON.stringify(value)
    if (current.key !== key || current.stopped) return
    current.chain = current.chain.then(async () => {
      if (current.stopped || current.last === serialized) return
      try {
        const result = await callViewOperation<Preference>(projectId, "save_view_preference", { scope, expectedRevision: current.revision, value })
        current.revision = result.revision
        current.last = serialized
        if (!current.stopped) setState(previous => ({ ...previous, error: undefined }))
      } catch (error) {
        current.stopped = true
        setState(previous => ({ ...previous, error: String(error) + " Your draft is retained. Reload before retrying." }))
      }
    })
  }, [key, projectId, scope])
  return { preference: state.key === key ? state.preference : undefined, error: state.key === key ? state.error : undefined, save }
}

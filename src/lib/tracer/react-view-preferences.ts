import type { ReactViewSummary } from "./react-views"

export const reactViewSelectionKey = (projectId: string) =>
  `datool:project-react-view:${projectId}`
export const reactViewLibraryEvent = "datool:project-react-views-changed"
export function selectProjectReactView(projectId: string, view: ReactViewSummary | null) {
  const id = view?.id ?? ""
  try {
    localStorage.setItem(reactViewSelectionKey(projectId), id)
  } catch {
    /* Optional browser preference. */
  }
  window.dispatchEvent(
    new CustomEvent(reactViewLibraryEvent, { detail: { projectId, id, view } })
  )
}

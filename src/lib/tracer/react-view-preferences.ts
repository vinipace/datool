export const reactViewSelectionKey = (projectId: string) =>
  `datool:project-react-view:${projectId}`
export const reactViewLibraryEvent = "datool:project-react-views-changed"
export function selectProjectReactView(projectId: string, id: string) {
  try {
    localStorage.setItem(reactViewSelectionKey(projectId), id)
  } catch {
    /* Optional browser preference. */
  }
  window.dispatchEvent(
    new CustomEvent(reactViewLibraryEvent, { detail: { projectId, id } })
  )
}

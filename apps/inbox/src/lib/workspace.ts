import { createContext, useContext } from "react"
import { useLocalSearchParams } from "expo-router"

export const WorkspaceContext = createContext<{ projectId: string; name?: string } | null>(null)

/** The project belongs to the parent route, not the currently selected tab. */
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext)
  const { name } = useLocalSearchParams<{ name?: string }>()
  if (!workspace) throw new Error("Workspace screens require a project.")
  // Deep-link query labels can live on the leaf screen; scope always comes
  // from the dynamic parent, even after native tab presses clear leaf params.
  return { ...workspace, name: workspace.name ?? name }
}

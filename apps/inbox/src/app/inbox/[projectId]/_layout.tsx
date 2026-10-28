import { Redirect, useLocalSearchParams } from "expo-router"
import WorkspaceTabs from "../../../components/workspace-tabs"
import { WorkspaceContext } from "../../../lib/workspace"

export default function WorkspaceLayout() {
  const { projectId, name } = useLocalSearchParams<{ projectId?: string; name?: string }>()
  if (!projectId) return <Redirect href="/" />
  // Native tab presses replace a child's params. Keep the project at the
  // dynamic parent route so every tab retains the same scope and cache keys.
  return <WorkspaceContext value={{ projectId, name }}><WorkspaceTabs /></WorkspaceContext>
}

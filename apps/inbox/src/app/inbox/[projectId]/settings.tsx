import Settings from "../../../screens/settings"
import { useWorkspace } from "../../../lib/workspace"

export default function AccountTab() {
  const { projectId } = useWorkspace()
  return <Settings tabbed projectId={projectId} />
}

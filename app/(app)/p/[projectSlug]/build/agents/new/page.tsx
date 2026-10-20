import { NewBuildAgentPage } from "@/components/build/agents/agent-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("newBuildAgent")

export default function Page() {
  return <NewBuildAgentPage />
}

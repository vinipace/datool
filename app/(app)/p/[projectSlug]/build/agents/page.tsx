import { BuildAgentsPage } from "@/components/build/agents/agents-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("buildAgents")

export default function Page() {
  return <BuildAgentsPage />
}

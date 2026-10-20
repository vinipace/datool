import { BuildAgentDetailPage } from "@/components/build/agents/agent-editor"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("buildAgentTest")

export default async function Page({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  return <BuildAgentDetailPage agentId={agentId} initialTab="test" />
}

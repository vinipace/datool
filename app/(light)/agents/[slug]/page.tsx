import { notFound } from "next/navigation"
import { AgentLandingPage } from "@/components/cms/agent-landing"
import {
  agentLandingContent,
  agentLandingPath,
} from "@/cms/agent-landing-content"
import { getPublishedAgentLanding } from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"

export const dynamic = "force-dynamic"
type Props = { params: Promise<{ slug: string }> }
async function getPage(slug: string) {
  return (
    (await getPublishedAgentLanding(slug)) ??
    agentLandingContent[slug] ??
    notFound()
  )
}
export async function generateMetadata({ params }: Props) {
  const { slug } = await params
  return cmsMetadata(await getPage(slug), agentLandingPath(slug))
}
export default async function AgentLanding({ params }: Props) {
  const { slug } = await params
  return <AgentLandingPage page={await getPage(slug)} />
}

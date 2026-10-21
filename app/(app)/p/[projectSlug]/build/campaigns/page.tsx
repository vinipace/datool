import { redirect } from "next/navigation"

/** Campaigns is temporarily unavailable; keep existing bookmarks in Build. */
export default async function BuildCampaignsRoute({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  redirect(`/p/${encodeURIComponent(projectSlug)}/build/agents`)
}

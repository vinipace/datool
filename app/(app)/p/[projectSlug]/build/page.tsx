import { redirect } from "next/navigation"

/** Agents is the Build home, so the area root keeps a single canonical URL. */
export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  redirect(`/p/${encodeURIComponent(projectSlug)}/build/agents`)
}

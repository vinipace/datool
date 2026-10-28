import { redirect } from "next/navigation"

/** The project-wide Conversation tests page has been retired. */
export default async function BuildTestsRoute({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  redirect(`/p/${encodeURIComponent(projectSlug)}/build/agents`)
}

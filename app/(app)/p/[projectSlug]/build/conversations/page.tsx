import { redirect } from "next/navigation"

export default async function BuildConversationsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { projectSlug } = await params
  const query = await searchParams
  const next = new URLSearchParams()
  if (typeof query.conversation === "string")
    next.set("conversation", query.conversation)
  const filters = ["agentId", "status", "channel"].flatMap((key) =>
    typeof query[key] === "string" && query[key]
      ? [`${key} = ${JSON.stringify(query[key])}`]
      : []
  )
  if (typeof query.q === "string" && query.q)
    filters.push(JSON.stringify(query.q))
  if (filters.length) next.set("filter", filters.join(" "))
  redirect(
    `/p/${encodeURIComponent(projectSlug)}/sessions${next.size ? `?${next}` : ""}`
  )
}

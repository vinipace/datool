import { redirect } from "next/navigation"

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  redirect(`/p/${encodeURIComponent(projectSlug)}/alerts`)
}

import { redirect } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"
import { workspaceReturnPath } from "@/lib/workspace-routing"

export const metadata = pageMetadata("organizations")

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { returnTo } = await searchParams
  const destination = workspaceReturnPath(returnTo, "/projects")
  redirect(`/?returnTo=${encodeURIComponent(destination)}`)
}

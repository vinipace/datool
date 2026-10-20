import { pageMetadata } from "@/lib/page-metadata"
import { InboxPage } from "@/components/build/operations/inbox-page"

export const metadata = pageMetadata("buildConversations")

export default async function BuildConversationsRoute({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  await params
  return <InboxPage view="conversations" />
}

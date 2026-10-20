import { pageMetadata } from "@/lib/page-metadata"
import { InboxPage } from "@/components/build/operations/inbox-page"

export const metadata = pageMetadata("buildInbox")

export default async function BuildInboxRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <InboxPage />
}

import { MembersPage } from "@/components/workspace/members-page"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("members")
export default async function Page() {
  const { organization } = await requireActiveOrganization("/members")
  return <MembersPage embedded organization={organization} />
}

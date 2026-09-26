import { UsagePage } from "@/components/workspace/usage-page"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("usage")
export default async function Page() {
  const { organization } = await requireActiveOrganization("/usage")
  return <UsagePage organization={organization} />
}

import { McpConnections } from "@/components/auth/mcp-connections"
import { pageMetadata } from "@/lib/page-metadata"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("mcpConnections")

export default async function Page() {
  const { organization } = await requireActiveOrganization("/settings/mcp")
  return (
    <McpConnections
      embedded
      organizationId={organization.id}
    />
  )
}

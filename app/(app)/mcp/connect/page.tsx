import { Suspense } from "react"
import { McpAuthorization } from "@/components/auth/mcp-authorization"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("mcpConnect")

export default function Page() {
  return (
    <Suspense>
      <McpAuthorization />
    </Suspense>
  )
}

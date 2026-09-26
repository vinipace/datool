import { Suspense } from "react"
import { McpAuthorization } from "@/components/auth/mcp-authorization"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("mcpConsent")

export default function Page() {
  return (
    <Suspense>
      <McpAuthorization consent />
    </Suspense>
  )
}

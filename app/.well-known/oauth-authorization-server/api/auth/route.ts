import { getOrganizationAuth } from "@/src/server/auth"
import { authBaseUrl } from "@/src/server/auth/config"
export const dynamic = "force-dynamic"
export async function GET() {
  const { auth } = await getOrganizationAuth()
  return auth.handler(new Request(`${authBaseUrl()}/api/auth/.well-known/oauth-authorization-server`))
}

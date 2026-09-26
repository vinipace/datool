import { headers } from "next/headers"
import { APIError } from "better-auth/api"
import { getAuth } from "@/lib/auth"
import { pageMetadata } from "@/lib/page-metadata"
import {
  InvitationPage,
  type InvitationView,
} from "@/components/workspace/invitation-page"
export const metadata = pageMetadata("invitation")
export const dynamic = "force-dynamic"
export default async function Page({
  params,
}: {
  params: Promise<{ invitationId: string }>
}) {
  const { invitationId } = await params
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  let invitation: InvitationView = { kind: "sign-in" }
  if (session) {
    try {
      const details = await getAuth().api.getInvitation({
        headers: requestHeaders,
        query: { id: invitationId },
      })
      invitation = {
        kind: "ready",
        email: session.user.email,
        organizationName: details.organizationName,
        role: details.role,
      }
    } catch (error) {
      if (!(error instanceof APIError) || error.statusCode >= 500) throw error
      invitation =
        error.statusCode === 403
          ? { kind: "wrong-account", email: session.user.email }
          : { kind: "unavailable" }
    }
  }
  return <InvitationPage id={invitationId} invitation={invitation} />
}

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { workspaceReturnPath } from "@/lib/workspace-routing"
import { getBillingRedirect } from "@/lib/billing-access"

export const getWorkspaceSession = cache(async () => {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })

  if (!session?.user?.id) return null

  return {
    headers: requestHeaders,
    userId: session.user.id,
    user: {
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  }
})

export async function requireWorkspaceSession(callbackUrl = "/") {
  const session = await getWorkspaceSession()
  if (!session) {
    const requestHeaders = await headers()
    const returnTo = workspaceReturnPath(
      requestHeaders.get("x-datool-workspace-path"),
      callbackUrl
    )
    redirect(`/sign-in?callbackUrl=${encodeURIComponent(returnTo)}`)
  }

  return session
}

export type WorkspaceOrganization = {
  id: string
  name: string
  slug: string
}

export async function requireActiveOrganization(callbackUrl = "/") {
  const {
    headers: requestHeaders,
    userId,
    user,
    activeOrganizationId: organizationId,
  } = await requireWorkspaceSession(callbackUrl)
  const returnTo = workspaceReturnPath(
    requestHeaders.get("x-datool-workspace-path"),
    callbackUrl
  )
  const selectionHref = `/?returnTo=${encodeURIComponent(returnTo)}`
  if (!organizationId) redirect(selectionHref)

  const result = await db.query<WorkspaceOrganization>(
    `SELECT o.id, o.name, o.slug
       FROM organization o
       JOIN member m
         ON m."organizationId" = o.id
        AND m."userId" = $2
      WHERE o.id = $1
      LIMIT 1`,
    [organizationId, userId]
  )
  const organization = result.rows[0]
  if (!organization) redirect(selectionHref)
  const billingRedirect = await getBillingRedirect(organization.id)
  const pathname = new URL(returnTo, "https://datool.invalid").pathname
  if (billingRedirect && pathname !== "/billing" && pathname !== "/pricing")
    redirect(billingRedirect)
  return {
    headers: requestHeaders,
    userId,
    user,
    organization,
    billingRedirect,
  }
}

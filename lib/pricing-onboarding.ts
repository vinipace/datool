import { cache } from "react"
import { db } from "@/lib/db"
import {
  getWorkspaceSession,
  requireActiveOrganization,
} from "@/lib/workspace-access"
import { memberRole } from "@/src/server/auth/config"
import { billingEnabled } from "@/src/server/billing/config"

/** The public pricing URL also resumes signed-in, unfinished organization setup. */
export const getPricingOnboarding = cache(async () => {
  if (!billingEnabled() || !(await getWorkspaceSession())) return null
  const workspace = await requireActiveOrganization("/pricing")
  if (workspace.billingRedirect !== "/pricing") return null
  const role = await memberRole(db, workspace.userId, workspace.organization.id)
  return {
    organization: workspace.organization,
    email: workspace.user.email,
    canManage: !!role
      ?.split(",")
      .some((value) => ["owner", "admin"].includes(value.trim())),
  }
})

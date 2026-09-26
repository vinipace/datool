import { OrganizationsPage } from "@/components/workspace/organizations-page"
import { BillingOnboarding } from "@/components/workspace/billing-onboarding"
import {
  billingPlanFromPath,
  type CloudPlan,
  type CloudPrices,
} from "@/src/lib/billing"
import { billingEnabled, cloudPrice } from "@/src/server/billing/config"
import { redirect } from "next/navigation"
import { analyticsDb, db } from "@/lib/db"
import { pageMetadata } from "@/lib/page-metadata"
import { getOrganizationEntryProject } from "@/lib/project-access"
import { getWorkspaceSession } from "@/lib/workspace-access"
import { projectHref } from "@/lib/workspace-api"
import { workspaceReturnPath } from "@/lib/workspace-routing"
import { getBillingRedirect } from "@/lib/billing-access"
import { MarketingShell } from "@/components/cms/marketing-shell"
import { cmsEnabled } from "@/lib/cms/config"
import LandingPage, {
  generateMetadata as landingMetadata,
} from "@/app/(marketing)/landing-page/page"

export const dynamic = "force-dynamic"

export async function generateMetadata() {
  return !cmsEnabled() || (await getWorkspaceSession())
    ? pageMetadata("organizations")
    : landingMetadata()
}

type OrganizationRow = {
  id: string
  name: string
  slug: string
  createdAt: Date
  projectCount: string
  plan: CloudPlan | null
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { returnTo } = await searchParams
  const destination = workspaceReturnPath(returnTo, "/projects")
  const session = await getWorkspaceSession()
  if (!session) {
    if (returnTo || !cmsEnabled())
      redirect(`/sign-in?${new URLSearchParams({ callbackUrl: destination })}`)
    return (
      <MarketingShell>
        <LandingPage />
      </MarketingShell>
    )
  }
  const { userId, activeOrganizationId } = session
  const result = await db.query<OrganizationRow>(
    `SELECT o.id,
            o.name,
            o.slug,
            o."createdAt" AS "createdAt",
            b.plan,
            COUNT(p.id)::text AS "projectCount"
       FROM organization o
       JOIN member m
         ON m."organizationId" = o.id
        AND m."userId" = $1
       LEFT JOIN project p ON p.organization_id = o.id
       LEFT JOIN organization_billing b ON b.organization_id = o.id
      GROUP BY o.id, o.name, o.slug, o."createdAt", b.plan
      ORDER BY o."createdAt" DESC, o.id DESC`,
    [userId]
  )
  const activeOrganization = result.rows.find(
    ({ id }) => id === activeOrganizationId
  )
  const plan = billingPlanFromPath(destination)
  if (activeOrganization && !plan) {
    const billingRedirect = await getBillingRedirect(activeOrganization.id)
    if (billingRedirect) redirect(billingRedirect)
  }
  if (!returnTo && activeOrganization) {
    const project = await getOrganizationEntryProject(activeOrganization.id)
    redirect(project ? projectHref(activeOrganization, project) : "/projects")
  }
  if (
    billingEnabled() &&
    (result.rows.length === 0 ||
      new URL(destination, "https://datool.invalid").pathname === "/billing")
  ) {
    let prices: CloudPrices | null = null
    try {
      if (plan) {
        const [core, pro] = await Promise.all([
          cloudPrice("core"),
          cloudPrice("pro"),
        ])
        prices = { core, pro }
      }
    } catch {
      // Keep organization selection available when Stripe prices cannot load.
    }
    return (
      <BillingOnboarding
        organizations={result.rows}
        plan={plan}
        prices={prices}
        email={session.user.email}
      />
    )
  }
  const traceCounts = await analyticsDb.query<{
    organizationId: string
    count: string
  }>(
    `SELECT p.organization_id AS "organizationId", COUNT(t.id)::text AS count
       FROM project p
       JOIN traces t ON t.project_id = p.id
      WHERE p.organization_id = ANY($1::text[])
      GROUP BY p.organization_id`,
    [result.rows.map((organization) => organization.id)]
  )
  const tracesByOrganization = new Map(
    traceCounts.rows.map((row) => [row.organizationId, Number(row.count)])
  )
  return (
    <OrganizationsPage
      billingEnabled={billingEnabled()}
      destination={destination}
      initialOrganizations={result.rows.map((organization) => ({
        ...organization,
        createdAt: new Date(organization.createdAt).toISOString(),
        projectCount: Number(organization.projectCount),
        traceCount: tracesByOrganization.get(organization.id) ?? 0,
      }))}
    />
  )
}

import { BillingOnboarding } from "@/components/workspace/billing-onboarding"
import { pageMetadata } from "@/lib/page-metadata"
import { requireWorkspaceSession } from "@/lib/workspace-access"
import { billingEnabled } from "@/src/server/billing/config"
import { shopifyBillingDestination } from "@/src/server/billing/shopify-access"
import { db } from "@/lib/db"
import { redirect } from "next/navigation"

export const metadata = pageMetadata("newOrganization")

export default async function NewOrganizationPage() {
  const session = await requireWorkspaceSession("/organizations/new")
  if (
    billingEnabled() &&
    (await shopifyBillingDestination(db, {
      userId: session.userId,
      headers: session.headers,
    }))
  )
    redirect("/shopify/connect")

  return (
    <BillingOnboarding
      organizations={[]}
      plan={null}
      prices={null}
      email={session.user.email}
      billingEnabled={billingEnabled()}
    />
  )
}

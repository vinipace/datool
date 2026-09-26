import { BillingOnboarding } from "@/components/workspace/billing-onboarding"
import { pageMetadata } from "@/lib/page-metadata"
import { requireWorkspaceSession } from "@/lib/workspace-access"
import { billingEnabled } from "@/src/server/billing/config"

export const metadata = pageMetadata("newOrganization")

export default async function NewOrganizationPage() {
  const session = await requireWorkspaceSession("/organizations/new")

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

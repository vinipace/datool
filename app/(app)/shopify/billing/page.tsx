import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { requireWorkspaceSession } from "@/lib/workspace-access"
import { ShopifyBillingReturn } from "@/components/workspace/shopify-onboarding"
import { Notice } from "@/components/ui/notice"
import { shopifyDomain } from "@/src/server/build/integrations/shopify-provider"

export const metadata = {
  title: "Shopify billing",
  robots: { index: false, follow: false },
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; plan_handle?: string }>
}) {
  const params = await searchParams
  let shop: string
  try {
    shop = shopifyDomain(params.shop ?? "")
  } catch {
    return (
      <Notice className="m-6" variant="warning">
        Open billing from Datool or your Shopify admin.
      </Notice>
    )
  }
  const session = await requireWorkspaceSession(
    `/shopify/billing?shop=${encodeURIComponent(shop)}`
  )
  // Return parameters select a destination only. Membership authorizes it;
  // the billing endpoint independently verifies the actual subscription.
  const result = await db.query<{ id: string; name: string }>(
    `SELECT o.id,o.name FROM organization_billing b JOIN organization o ON o.id=b.organization_id
     JOIN member m ON m."organizationId"=o.id AND m."userId"=$3
     WHERE b.provider='shopify' AND b.shopify_shop=$1 AND b.shopify_client_id=$2`,
    [shop, process.env.DATOOL_SHOPIFY_CLIENT_ID, session.userId]
  )
  const organization = result.rows[0]
  if (!organization)
    return (
      <Notice className="m-6" variant="warning">
        Sign in with an account that belongs to this store's Datool
        organization.
      </Notice>
    )
  if (session.activeOrganizationId === organization.id)
    redirect("/billing?checkout=success")
  return (
    <ShopifyBillingReturn
      organizationId={organization.id}
      organizationName={organization.name}
      shop={shop}
    />
  )
}

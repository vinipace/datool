import { db } from "@/lib/db"
import { requireWorkspaceSession } from "@/lib/workspace-access"
import {
  ShopifyOnboarding,
  ShopifyBillingStart,
} from "@/components/workspace/shopify-onboarding"
import { getShopifyInstall } from "@/src/server/build/integrations/shopify-install"
import { shopifyOrigin } from "@/src/server/build/integrations/shopify-provider"

export const metadata = {
  title: "Connect Shopify",
  robots: { index: false, follow: false },
}

export default async function Page() {
  const session = await requireWorkspaceSession("/shopify/connect")
  const intent = await getShopifyInstall(
    db,
    new Request(`${shopifyOrigin()}/shopify/connect`, {
      headers: session.headers,
    })
  ).catch(() => null)
  if (!intent) {
    const { rows } = await db.query<{ id: string; name: string }>(
      `SELECT o.id,o.name FROM organization o
       JOIN member m ON m."organizationId"=o.id AND m."userId"=$1
       JOIN organization_billing b ON b.organization_id=o.id AND b.provider='shopify'
       ORDER BY o.name`,
      [session.userId]
    )
    const handle = process.env.DATOOL_SHOPIFY_APP_HANDLE ?? ""
    return (
      <ShopifyBillingStart
        organizations={rows}
        installUrl={
          /^[a-z0-9][a-z0-9-]*$/.test(handle)
            ? `https://apps.shopify.com/${handle}`
            : null
        }
      />
    )
  }
  const { rows } = await db.query<{
    id: string
    name: string
    projects: { id: string; name: string }[]
    billingConflict: boolean
  }>(
    `SELECT o.id,o.name,COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name) FILTER(WHERE p.id IS NOT NULL),'[]') AS projects,
     COALESCE(b.provider='stripe' AND (b.customer_id IS NOT NULL OR b.subscription_id IS NOT NULL OR b.checkout_session_id IS NOT NULL),false) AS "billingConflict"
     FROM organization o JOIN member m ON m."organizationId"=o.id AND m."userId"=$1
     LEFT JOIN project p ON p.organization_id=o.id
     LEFT JOIN organization_billing b ON b.organization_id=o.id
     WHERE string_to_array(replace(m.role,' ',''),',') && ARRAY['owner','admin']
     GROUP BY o.id,b.organization_id ORDER BY o.name`,
    [session.userId]
  )
  const existing = await db.query<{ project_id: string }>(
    `SELECT c.project_id FROM build_shopify_connections c
     JOIN project p ON p.id=c.project_id
     JOIN member m ON m."organizationId"=p.organization_id AND m."userId"=$3
     WHERE c.shop=$1 AND c.client_id=$2
       AND string_to_array(replace(m.role,' ',''),',') && ARRAY['owner','admin']`,
    [intent.shop, intent.client_id, session.userId]
  )
  return (
    <ShopifyOnboarding
      shop={intent.shop!}
      organizations={rows}
      projectId={
        intent.project_id ??
        intent.claimed_project_id ??
        existing.rows[0]?.project_id
      }
    />
  )
}

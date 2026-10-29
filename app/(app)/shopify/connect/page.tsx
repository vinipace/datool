import { db } from "@/lib/db"
import { requireWorkspaceSession } from "@/lib/workspace-access"
import { Notice } from "@/components/ui/notice"
import { Button } from "@/components/ui/button"
import { ShopifyOnboarding } from "@/components/workspace/shopify-onboarding"
import { getShopifyInstall } from "@/src/server/build/integrations/shopify-install"
import { shopifyOrigin } from "@/src/server/build/integrations/shopify-provider"
import Link from "next/link"

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
  if (!intent)
    return (
      <main className="mx-auto max-w-xl space-y-4 p-6">
        <Notice variant="warning">
          This Shopify connection expired. Reopen Datool from Shopify or start
          again in Integrations.
        </Notice>
        <Button asChild>
          <Link href="/projects">Open Datool</Link>
        </Button>
      </main>
    )
  const { rows } = await db.query<{
    id: string
    name: string
    projects: { id: string; name: string }[]
  }>(
    `SELECT o.id,o.name,COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name) FILTER(WHERE p.id IS NOT NULL),'[]') AS projects
     FROM organization o JOIN member m ON m."organizationId"=o.id AND m."userId"=$1
     LEFT JOIN project p ON p.organization_id=o.id
     WHERE string_to_array(replace(m.role,' ',''),',') && ARRAY['owner','admin']
     GROUP BY o.id ORDER BY o.name`,
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
      source={intent.source}
      organizations={rows}
      projectId={
        intent.project_id ??
        intent.claimed_project_id ??
        existing.rows[0]?.project_id
      }
    />
  )
}

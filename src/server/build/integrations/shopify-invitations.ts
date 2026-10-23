import { createHmac } from "node:crypto"
import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"
import { channelSigningSecret } from "../channels/visitor"

/** Suppress repeated sends to one address across agents and browsers. */
export async function claimShopifyInvitation(
  context: BuildContext,
  connectionId: string,
  email: string
) {
  const recipient = createHmac("sha256", channelSigningSecret())
    .update(`shopify-invitation:${email.trim().toLowerCase()}`)
    .digest("hex")
  await context.database.execute(sql`
    DELETE FROM build_shopify_invitation_cooldown WHERE project_id=${context.projectId}
      AND connection_id=${connectionId}::uuid AND attempted_at<now()-interval '1 day'
  `)
  const result = await context.database.execute(sql`
    INSERT INTO build_shopify_invitation_cooldown(project_id,connection_id,recipient_hash)
    VALUES (${context.projectId},${connectionId}::uuid,${recipient})
    ON CONFLICT (project_id,connection_id,recipient_hash) DO UPDATE SET attempted_at=now()
    WHERE build_shopify_invitation_cooldown.attempted_at<now()-interval '10 minutes'
    RETURNING recipient_hash
  `)
  return Boolean(result.rows.length)
}

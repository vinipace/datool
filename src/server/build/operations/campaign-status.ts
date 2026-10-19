import { sql } from "drizzle-orm"
import type { BuildContext } from "../context"

type OperationsExecutor = Pick<BuildContext["database"], "execute">

/** Marks a running campaign terminal once every frozen recipient is terminal. */
export async function reconcileCampaignStatus(
  executor: OperationsExecutor,
  projectId: string,
  campaignId: string,
) {
  const result = await executor.execute<{
    status: string
    has_pending: boolean
    has_failed: boolean
  }>(sql`
    select c.status,
      exists (
        select 1 from build_campaign_deliveries d
        where d.project_id=c.project_id and d.campaign_id=c.id
          and d.state in ('queued','sending')
      ) as has_pending,
      exists (
        select 1 from build_campaign_deliveries d
        where d.project_id=c.project_id and d.campaign_id=c.id and d.state='failed'
      ) as has_failed
    from build_campaigns c
    where c.project_id=${projectId} and c.id=${campaignId}
    for update
  `)
  const row = result.rows[0]
  if (!row || row.status !== "running" || row.has_pending) return null
  const nextStatus = row.has_failed ? "failed" : "completed"
  await executor.execute(sql`
    update build_campaigns
    set status=${nextStatus},updated_at=now()
    where project_id=${projectId} and id=${campaignId} and status='running'
  `)
  return nextStatus
}

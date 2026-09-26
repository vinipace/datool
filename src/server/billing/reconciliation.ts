import { db } from "@/lib/db"
import { billingEnabled } from "./config"
import { reconcileBillingOrganization } from "./store"

/** Due times and retries live in PostgreSQL, so quiet organizations and worker
 * restarts need no browser traffic, Redis job history, or in-memory cursor. */
export async function reconcileCloudBilling({
  batchSize = 50,
  signal,
}: { batchSize?: number; signal?: AbortSignal } = {}) {
  const totals = { scanned: 0, synced: 0, failed: 0, skipped: 0 }
  if (!billingEnabled() || signal?.aborted) return totals
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error(
      "Billing reconciliation batches must contain 1–100 organizations."
    )
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM organization_billing
     WHERE customer_id IS NOT NULL AND reconcile_after <= now()
     ORDER BY reconcile_after,organization_id LIMIT $1`,
    [batchSize]
  )
  const started = Date.now()
  for (const { organization_id: organizationId } of rows) {
    // Keep sweeps bounded; shutdown waits only for the organization in progress.
    if (signal?.aborted || Date.now() - started >= 45_000) break
    totals.scanned++
    try {
      const result = await reconcileBillingOrganization(organizationId)
      if (!result) {
        totals.skipped++
      } else if (result.status === "synced") {
        totals.synced++
      } else {
        totals.failed++
        const report = JSON.stringify({
          event: "billing_reconciliation_failed",
          organizationId,
          consecutiveFailures: result.reconcile_failures,
          nextAttemptAt: result.reconcile_after.toISOString(),
          requiresAttention: result.reconcile_failures >= 3,
        })
        if (result.reconcile_failures >= 3) console.error(report)
        // Production maps stderr to ERROR, so transient failures stay on stdout.
        else console.info(report)
      }
    } catch {
      totals.failed++
      console.error(
        JSON.stringify({
          event: "billing_reconciliation_error",
          organizationId,
        })
      )
    }
  }
  console.info(
    JSON.stringify({ event: "billing_reconciliation_sweep", ...totals })
  )
  return totals
}

export function startBillingReconciliationWorker() {
  if (!billingEnabled()) return async () => {}
  const controller = new AbortController()
  let running: Promise<unknown> | undefined
  const tick = () => {
    if (running || controller.signal.aborted) return
    running = reconcileCloudBilling({ signal: controller.signal })
      .catch(() =>
        console.error(
          JSON.stringify({ event: "billing_reconciliation_sweep_failed" })
        )
      )
      .finally(() => {
        running = undefined
      })
  }
  // Poll due work each minute; every successful Stripe sync schedules +15 min.
  const timer = setInterval(tick, 60_000)
  timer.unref()
  tick()
  return async () => {
    clearInterval(timer)
    controller.abort()
    await running
  }
}

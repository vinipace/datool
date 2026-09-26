import { db } from "@/lib/db"
import { billingEnabled } from "@/src/server/billing/config"
import { getBilling } from "@/src/server/billing/store"
import { executionCredits, ExecutionCreditError } from "./ledger"

export const managedExecutionEnabled = () =>
  billingEnabled() && process.env.DATOOL_MANAGED_EXECUTION_ENABLED === "true"
export function managedRuntimeConfigured(runtime: "model" | "sandbox") {
  return (
    managedExecutionEnabled() &&
    (runtime === "model"
      ? Boolean(process.env.DATOOL_SCORER_OPENAI_API_KEY)
      : Boolean(
          process.env.DATOOL_MODAL_TOKEN_ID &&
          process.env.DATOOL_MODAL_TOKEN_SECRET
        ))
  )
}
export async function managedProjectAvailable(
  projectId: string,
  runtime: "model" | "sandbox"
) {
  if (!managedRuntimeConfigured(runtime)) return false
  const { rows } = await db.query(
    "SELECT organization_id FROM project WHERE id=$1",
    [projectId]
  )
  if (!rows[0]) return false
  const billing = await getBilling(rows[0].organization_id)
  if (
    billing?.status !== "active" ||
    !billing.access_until ||
    billing.access_until.getTime() <= Date.now()
  )
    return false
  // Keep the option selectable when exhausted, so its funding source is visible.
  return (await executionCredits.usage(rows[0].organization_id)).allowance > 0
}
export async function assertManagedProject(
  projectId: string,
  runtime: "model" | "sandbox"
) {
  if (!(await managedProjectAvailable(projectId, runtime)))
    throw new ExecutionCreditError(
      "Datool execution requires an active paid Core or Pro plan and a configured managed runtime."
    )
}

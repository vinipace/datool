import { accessError, apiError } from "@/lib/api-response"
import { requireOrganizationRole } from "@/lib/project-access"
import { executionCredits } from "@/src/server/execution-credits/ledger"
import { getCloudUsage } from "@/src/server/billing/usage"
import { getBilling } from "@/src/server/billing/store"

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
) {
  const { organizationId } = await context.params
  const authorization = await requireOrganizationRole(request, organizationId)
  if (authorization.kind !== "ok") return accessError(authorization.kind)
  try {
    const billing = await getBilling(organizationId)
    const [credits, records] = await Promise.all([
      executionCredits.usage(organizationId),
      getCloudUsage(organizationId),
    ])
    return Response.json(
      { credits, records, plan: billing?.plan ?? null },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return apiError(
      "INTERNAL_ERROR",
      "Unable to load organization usage. Please try again.",
      503
    )
  }
}

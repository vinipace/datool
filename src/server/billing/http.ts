import { getAuth } from "@/lib/auth"
import {
  accessError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireOrganizationRole } from "@/lib/project-access"
import { TracerError } from "@/src/server/tracer/errors"
import { billingConfig, billingEnabled, type BillingPlan } from "./config"
import {
  createCheckout,
  createPortal,
  getBilling,
  hasSubscriptionAccess,
} from "./store"
import { getCloudUsage } from "./usage"

export async function billingRequest(
  request: Request,
  action: "status" | "checkout" | "portal"
) {
  if (!billingEnabled())
    return Response.json(
      { error: { message: "Cloud billing is disabled." } },
      { status: 404 }
    )
  try {
    if (action !== "status" && !hasTrustedMutationOrigin(request))
      return accessError("forbidden")
    const session = await getAuth().api.getSession({ headers: request.headers })
    if (!session?.user.id) return accessError("unauthenticated")
    const organizationId = session.session.activeOrganizationId
    if (!organizationId)
      throw new TracerError("VALIDATION_ERROR", "Select an organization first.")
    const authorization = await requireOrganizationRole(
      request,
      organizationId,
      { manage: action !== "status" }
    )
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    if (action === "status") {
      const row = await getBilling(organizationId, true)
      return Response.json(
        {
          status: row?.status ?? "none",
          active: hasSubscriptionAccess(row),
          plan: row?.price_id
            ? (Object.entries(billingConfig().prices).find(
                ([, price]) => price === row.price_id
              )?.[0] ?? null)
            : null,
          currentPeriodEnd: row?.current_period_end?.toISOString() ?? null,
          cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
          hasCustomer: !!row?.customer_id,
          graceUntil: row?.grace_until?.toISOString() ?? null,
          nextPaymentAttempt: row?.next_payment_attempt?.toISOString() ?? null,
          usage: await getCloudUsage(organizationId),
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    }
    let url: string
    if (action === "checkout") {
      const body = await readJson(request, 1024)
      const plan =
        body.kind === "ok" &&
        body.value &&
        typeof body.value === "object" &&
        "plan" in body.value
          ? body.value.plan
          : null
      if (plan !== "core" && plan !== "pro")
        throw new TracerError("VALIDATION_ERROR", "Choose a valid Cloud plan.")
      url = await createCheckout(
        organizationId,
        plan as BillingPlan,
        session.user.email
      )
    } else url = await createPortal(organizationId)
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return Response.json(
      {
        error: {
          message:
            error instanceof TracerError
              ? error.message
              : "Billing is temporarily unavailable. Please try again shortly.",
        },
      },
      {
        status: error instanceof TracerError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      }
    )
  }
}

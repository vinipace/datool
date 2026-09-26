import { BillingPage } from "@/components/workspace/billing-page"
import { Notice } from "@/components/ui/notice"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { db } from "@/lib/db"
import { pageMetadata } from "@/lib/page-metadata"
import { billingEnabled, cloudPrice } from "@/src/server/billing/config"
import { memberRole } from "@/src/server/auth/config"
import { billingPath, type CloudPrices } from "@/src/lib/billing"
import { redirect } from "next/navigation"
import { OnboardingAccount } from "@/components/auth/onboarding-account"

export const metadata = pageMetadata("billing")
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; checkout?: string }>
}) {
  const params = await searchParams
  const plan = params.plan === "pro" ? "pro" : "core"
  const { organization, userId, user, billingRedirect } =
    await requireActiveOrganization(
      billingPath(
        plan,
        params.checkout === "success" || params.checkout === "canceled"
          ? params.checkout
          : undefined
      )
    )
  if (
    billingRedirect === "/pricing" &&
    params.plan !== "core" &&
    params.plan !== "pro" &&
    params.checkout !== "success"
  )
    redirect("/pricing")
  if (!billingEnabled())
    return (
      <Notice className="m-6">
        Billing is disabled on this installation. Your workspace does not
        require a subscription.
      </Notice>
    )
  const role = await memberRole(db, userId, organization.id)
  let prices: CloudPrices | null = null
  try {
    const [core, pro] = await Promise.all([
      cloudPrice("core"),
      cloudPrice("pro"),
    ])
    prices = { core, pro }
  } catch {
    /* The page remains usable for existing customers when prices fail. */
  }
  return (
    <>
      <BillingPage
        key={`${organization.id}:${plan}`}
        organizationName={organization.name}
        canManage={
          !!role
            ?.split(",")
            .some((value) => ["owner", "admin"].includes(value.trim()))
        }
        prices={prices}
        initialPlan={plan}
        checkout={params.checkout}
      />
      {billingRedirect ? (
        <div className="mx-auto max-w-3xl px-4 pb-10 sm:px-6">
          <OnboardingAccount email={user.email} />
        </div>
      ) : null}
    </>
  )
}

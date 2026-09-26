"use client"

import { createContext, useContext, useState, type ReactNode } from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  navigateWorkspace,
  useOrganizationSessionSync,
} from "@/lib/workspace-selection"
import { billingPath, cloudPlans, type CloudPlan } from "@/src/lib/billing"

type Onboarding = {
  organizationId: string
  canManage: boolean
  pricesAvailable: boolean
}
type Checkout = {
  busy: CloudPlan | null
  error: { plan: CloudPlan; message: string } | null
  disabled: boolean
  open: (plan: CloudPlan) => Promise<void>
}
const CheckoutContext = createContext<Checkout | null>(null)

/** Keep the public pricing content and its CTAs shared with account setup. */
export function PricingCheckout({
  onboarding,
  children,
}: {
  onboarding: Onboarding | null
  children: ReactNode
}) {
  if (!onboarding) return children
  return <OnboardingCheckout {...onboarding}>{children}</OnboardingCheckout>
}

function OnboardingCheckout({
  organizationId,
  canManage,
  pricesAvailable,
  children,
}: Onboarding & { children: ReactNode }) {
  useOrganizationSessionSync(organizationId)
  const [busy, setBusy] = useState<CloudPlan | null>(null)
  const [error, setError] = useState<Checkout["error"]>(null)
  async function open(plan: CloudPlan) {
    if (busy || !pricesAvailable || !canManage) return
    setBusy(plan)
    setError(null)
    try {
      const result = await workspaceRequest<{ url: string }>(
        "/api/billing/checkout",
        {
          method: "POST",
          body: JSON.stringify({ plan }),
        }
      )
      navigateWorkspace(result.url)
    } catch (cause) {
      setError({
        plan,
        message:
          cause instanceof Error
            ? cause.message
            : "Unable to open payment. Please try again.",
      })
      setBusy(null)
    }
  }
  return (
    <CheckoutContext.Provider
      value={{
        busy,
        error,
        disabled: !!busy || !pricesAvailable || !canManage,
        open,
      }}
    >
      {!canManage ? (
        <Notice className="mt-8">
          Ask an organization owner or admin to choose a plan and complete
          payment.
        </Notice>
      ) : null}
      {children}
    </CheckoutContext.Provider>
  )
}

export function PricingPlanAction({
  plan,
  billingEnabled,
  ...props
}: {
  plan: CloudPlan
  billingEnabled: boolean
} & Pick<ButtonProps, "size" | "shape" | "className">) {
  const checkout = useContext(CheckoutContext)
  const label = (
    <>
      Get {cloudPlans.find((item) => item.id === plan)!.name}{" "}
      <ArrowUpRight aria-hidden="true" />
    </>
  )
  const variant = plan === "pro" ? "marketing" : "default"
  if (!checkout)
    return (
      <Button {...props} asChild variant={variant}>
        <Link href={billingEnabled ? billingPath(plan) : "/sign-up"}>
          {label}
        </Link>
      </Button>
    )
  return (
    <>
      <Button
        {...props}
        variant={variant}
        disabled={checkout.disabled}
        loading={checkout.busy === plan}
        onClick={() => void checkout.open(plan)}
      >
        {label}
      </Button>
      {checkout.error?.plan === plan ? (
        <Notice variant="error" role="alert" className="mt-3 text-left">
          {checkout.error.message}
        </Notice>
      ) : null}
    </>
  )
}

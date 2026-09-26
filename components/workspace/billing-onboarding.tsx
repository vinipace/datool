"use client"

import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { OnboardingShell } from "@/components/auth/onboarding-shell"
import { OnboardingAccount } from "@/components/auth/onboarding-account"
import { RequestStory } from "@/components/cms/landing-visuals"
import { OnboardingPlanSummary } from "./onboarding-plan-summary"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { authClient } from "@/lib/auth-client"
import { useHydrated } from "@/lib/use-hydrated"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  navigateWorkspace,
  selectOrganization,
} from "@/lib/workspace-selection"
import {
  billingPath,
  cloudPlans,
  type CloudPlan,
  type CloudPrices,
} from "@/src/lib/billing"

type Organization = { id: string; name: string }

export function BillingOnboarding({
  organizations,
  plan,
  prices,
  email,
  billingEnabled = true,
}: {
  organizations: Organization[]
  plan: CloudPlan | null
  prices: CloudPrices | null
  email: string
  billingEnabled?: boolean
}) {
  const router = useRouter()
  const hydrated = useHydrated()
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (hydrated) nameInput.current?.focus()
  }, [hydrated])
  const nameId = useId()
  const [name, setName] = useState("")
  const [created, setCreated] = useState<Organization | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const selected = cloudPlans.find((item) => item.id === plan)
  const nextPage = billingEnabled
    ? plan
      ? billingPath(plan)
      : "/pricing"
    : "/projects"

  async function continueToPayment(event: FormEvent) {
    event.preventDefault()
    if (busy || (plan && !prices) || (!created && !name.trim())) return
    setBusy(true)
    setError("")
    try {
      let organization = created
      if (!organization) {
        const slug =
          name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")
            .slice(0, 48) || "organization"
        const result = await authClient.organization.create({
          name: name.trim(),
          slug: `${slug}-${crypto.randomUUID().slice(0, 8)}`,
        })
        if (result.error) throw result.error
        if (!result.data)
          throw new Error("Unable to create your organization. Try again.")
        organization = result.data
        // A failed selection or checkout must retry this organization, not create another.
        setCreated(organization)
      }
      await selectOrganization(organization.id)
      if (!billingEnabled || !plan) {
        navigateWorkspace(nextPage)
        return
      }
      const result = await workspaceRequest<{ url: string }>(
        "/api/billing/checkout",
        {
          method: "POST",
          body: JSON.stringify({ plan }),
        }
      )
      navigateWorkspace(result.url)
    } catch (cause) {
      setError(
        cause && typeof cause === "object" && "message" in cause
          ? String(cause.message)
          : "Unable to continue. Please try again."
      )
      setBusy(false)
    }
  }

  async function openOrganization(organization: Organization) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await selectOrganization(organization.id)
      navigateWorkspace(nextPage)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to select your organization."
      )
      setBusy(false)
    }
  }

  return (
    <OnboardingShell
      title={
        created
          ? !billingEnabled
            ? "Your organization is ready"
            : plan
              ? "Continue to payment"
              : "Choose your plan"
          : organizations.length
            ? "Choose your organization"
            : "Create your organization"
      }
      description={
        billingEnabled
          ? "Your projects and subscription live here. You can invite teammates later."
          : "Your projects live here. You can invite teammates later."
      }
      aside={
        plan ? (
          <OnboardingPlanSummary plan={plan} prices={prices} />
        ) : (
          <RequestStory />
        )
      }
      hideAsideOnMobile={!plan}
      footer={<OnboardingAccount email={email} />}
    >
      <div className="space-y-6">
        {plan && !prices ? (
          <Notice variant="warning">
            Plan prices are unavailable.{" "}
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => router.refresh()}
            >
              Try again
            </Button>
          </Notice>
        ) : null}
        {error ? (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        ) : null}
        {created ? (
          <Notice variant="success">
            {created.name} is ready.{" "}
            {!billingEnabled
              ? "Continue to set up your first project."
              : plan
                ? "Continue below to finish payment."
                : "Choose a plan to continue."}
          </Notice>
        ) : null}
        {!created && organizations.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-foreground-muted">
              Use an existing organization
            </p>
            {organizations.map((organization) => (
              <Button
                key={organization.id}
                variant="outline"
                className="w-full justify-start"
                disabled={busy}
                onClick={() => void openOrganization(organization)}
              >
                <span className="truncate">{organization.name}</span>
              </Button>
            ))}
            <p className="pt-4 text-sm text-foreground-muted">
              Or create a new one
            </p>
          </div>
        ) : null}
        <form onSubmit={continueToPayment} className="space-y-4">
          {!created ? (
            <div className="space-y-2">
              <label htmlFor={nameId} className="text-sm font-medium">
                Organization name
              </label>
              <Input
                ref={nameInput}
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your company or team"
                autoComplete="organization"
                autoFocus
                required
                maxLength={120}
                disabled={!hydrated || busy}
              />
            </div>
          ) : null}
          <Button
            className="w-full"
            type="submit"
            loading={busy}
            disabled={!hydrated || !!(plan && !prices) || (!created && !name.trim())}
          >
            {!billingEnabled
              ? created
                ? "Continue to workspace"
                : "Create organization"
              : plan
                ? created
                  ? "Continue to payment"
                  : "Create & continue to payment"
                : created
                  ? "Choose a plan"
                  : "Create & choose a plan"}
          </Button>
          <p className="text-xs text-foreground-muted">
            {!billingEnabled ? (
              "Next, create your first project."
            ) : plan && selected ? (
              <>
                {prices?.[plan].trialDays
                  ? `${prices[plan].trialDays}-day trial, then billed monthly in USD. `
                  : "Billed monthly in USD. "}
                You’ll review and confirm your {selected.name} subscription
                securely with Stripe.
              </>
            ) : (
              "Next, choose a Cloud plan and complete payment to start using your workspace."
            )}
          </p>
        </form>
        {created && plan ? (
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={billingPath(plan)}>Back to billing</Link>
          </Button>
        ) : null}
      </div>
    </OnboardingShell>
  )
}

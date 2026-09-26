"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { GoogleSignIn } from "@/components/auth/google-sign-in"
import { EmailSignIn } from "@/components/auth/email-sign-in"
import { AuthShell } from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { oauthErrorMessage, signInLinkErrorMessage } from "@/lib/auth-error"
import { workspaceReturnPath } from "@/lib/workspace-routing"
import {
  billingPlanFromPath,
  cloudPlans,
  type CloudPrices,
} from "@/src/lib/billing"
import { OnboardingShell } from "@/components/auth/onboarding-shell"
import { OnboardingPlanSummary } from "@/components/workspace/onboarding-plan-summary"

export function SignInForm({
  publicSignup = false,
  prices = null,
}: { publicSignup?: boolean; prices?: CloudPrices | null } = {}) {
  const searchParams = useSearchParams()
  const requested = searchParams.get("callbackUrl")
  const callbackURL = workspaceReturnPath(requested)
  const plan = cloudPlans.find(
    (item) => item.id === billingPlanFromPath(callbackURL)
  )
  const isSignUp = usePathname() === "/sign-up"
  const path = isSignUp ? "/sign-up" : "/sign-in"
  const returnQuery = requested
    ? `?${new URLSearchParams({ callbackUrl: callbackURL })}`
    : ""
  const emailErrorQuery = new URLSearchParams({
    callbackUrl: callbackURL,
    method: "email",
  })
  const [config, setConfig] = useState<{
    google: boolean
    emailLink: boolean
  } | null>(null)

  useEffect(() => {
    let active = true
    void fetch("/api/auth/config")
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load sign-in options")
        return response.json()
      })
      .then((data) => {
        if (active)
          setConfig({
            google: data.google === true,
            emailLink: data.emailLink === true,
          })
      })
      .catch(() => {
        if (active) setConfig({ google: false, emailLink: false })
      })
    return () => {
      active = false
    }
  }, [])

  const Shell = plan ? OnboardingShell : AuthShell

  return (
    <Shell
      title={plan ? `Get started with ${plan.name}` : "Sign in to Datool"}
      description={
        plan
          ? "Sign in or create an account to bring your team to Datool."
          : undefined
      }
      aside={
        plan ? <OnboardingPlanSummary plan={plan.id} prices={prices} /> : null
      }
      footer={
        (isSignUp || publicSignup) && (
          <p>
            {isSignUp ? "Already have an account?" : "New to Datool?"}{" "}
            <Button asChild variant="link" className="h-auto p-0">
              <Link
                href={`${isSignUp ? "/sign-in" : "/sign-up"}${returnQuery}`}
              >
                {isSignUp ? "Log in" : "Sign up"}
              </Link>
            </Button>
          </p>
        )
      }
    >
      {searchParams.has("error") && (
        <Notice role="alert" variant="error" className="mt-4">
          {searchParams.get("method") === "email"
            ? signInLinkErrorMessage(searchParams.get("error"))
            : oauthErrorMessage(searchParams.get("error"))}
        </Notice>
      )}
      {config?.emailLink && (
        <EmailSignIn
          callbackURL={callbackURL}
          errorCallbackURL={`${path}?${emailErrorQuery}`}
        />
      )}
      {config?.emailLink && config.google && (
        <div className="mt-6 flex items-center gap-3 text-xs text-foreground-muted">
          <span className="h-px flex-1 bg-border" />
          <span>or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {config?.google || !config || !config.emailLink ? (
        <GoogleSignIn
          callbackURL={callbackURL}
          errorCallbackURL={`${path}${returnQuery}`}
          enabled={config?.google ?? null}
        />
      ) : null}
    </Shell>
  )
}

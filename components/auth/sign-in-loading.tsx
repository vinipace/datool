"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { AuthShell } from "@/components/auth/auth-shell"
import { OnboardingShell } from "@/components/auth/onboarding-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { OnboardingPlanSummary } from "@/components/workspace/onboarding-plan-summary"
import {
  billingPlanFromPath,
  cloudPlans,
  type CloudPlan,
} from "@/src/lib/billing"

function SignInSkeleton({ plan }: { plan?: CloudPlan | null }) {
  const selected = cloudPlans.find((item) => item.id === plan)
  const Shell = selected ? OnboardingShell : AuthShell

  return (
    <Shell
      title={
        selected ? `Get started with ${selected.name}` : "Sign in to Datool"
      }
      description={
        selected
          ? "Sign in or create an account to bring your team to Datool."
          : undefined
      }
      aside={
        selected ? (
          <OnboardingPlanSummary
            plan={selected.id}
            prices={null}
            loadingPrice
          />
        ) : null
      }
    >
      <div
        role="status"
        aria-label="Loading sign-in options"
        className="space-y-4"
      >
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <div className="py-3">
          <Skeleton className="h-px w-full" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </Shell>
  )
}

function RouteSignInSkeleton() {
  const searchParams = useSearchParams()
  return (
    <SignInSkeleton
      plan={billingPlanFromPath(searchParams.get("callbackUrl") ?? "")}
    />
  )
}

/** Keep auth loading inside its own boundary, including query-param resolution. */
export function SignInLoading() {
  return (
    <Suspense fallback={<SignInSkeleton />}>
      <RouteSignInSkeleton />
    </Suspense>
  )
}

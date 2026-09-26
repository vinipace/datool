import { OnboardingShell } from "@/components/auth/onboarding-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { RequestStory } from "@/components/cms/landing-visuals"

export default function Loading() {
  return (
    <OnboardingShell
      title="Preparing your workspace"
      aside={<RequestStory />}
      hideAsideOnMobile
    >
      <div
        role="status"
        aria-label="Loading project setup"
        className="space-y-5"
      >
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </OnboardingShell>
  )
}

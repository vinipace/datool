import { Suspense } from "react"
import { SignInForm } from "@/components/auth/sign-in-form"
import { SignInLoading } from "@/components/auth/sign-in-loading"
import { pageMetadata } from "@/lib/page-metadata"
import { billingPlanFromPath, type CloudPrices } from "@/src/lib/billing"
import { billingEnabled, cloudPrice } from "@/src/server/billing/config"

export const metadata = pageMetadata("signIn")
export const dynamic = "force-dynamic"

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>
}) {
  const { callbackUrl } = await searchParams
  let prices: CloudPrices | null = null
  if (billingEnabled() && billingPlanFromPath(callbackUrl ?? "")) {
    try {
      const [core, pro] = await Promise.all([
        cloudPrice("core"),
        cloudPrice("pro"),
      ])
      prices = { core, pro }
    } catch {
      // Authentication stays available while prices cannot load.
    }
  }
  return (
    <Suspense fallback={<SignInLoading />}>
      <SignInForm
        publicSignup={process.env.AUTH_ALLOW_PUBLIC_SIGNUP === "true"}
        prices={prices}
      />
    </Suspense>
  )
}

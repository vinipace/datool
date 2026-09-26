export type CloudPlan = "core" | "pro"

export function billingPath(
  plan: CloudPlan,
  checkout?: "success" | "canceled"
) {
  const query = new URLSearchParams({ plan })
  if (checkout) query.set("checkout", checkout)
  return `/billing?${query}`
}

/** Read plan intent only from an internal billing destination. */
export function billingPlanFromPath(path: string): CloudPlan | null {
  try {
    const url = new URL(path, "https://datool.invalid")
    if (url.origin !== "https://datool.invalid" || url.pathname !== "/billing")
      return null
    const plan = url.searchParams.get("plan")
    return plan === "core" || plan === "pro" ? plan : null
  } catch {
    return null
  }
}
export type CloudPrices = Record<
  CloudPlan,
  { amount: number; currency: string; trialDays: number }
>
export const cloudPlans = [
  {
    id: "core" as const,
    name: "Core",
    description: "A home for your AI projects.",
    monthlyRecords: 100_000,
    retentionDays: 90,
  },
  {
    id: "pro" as const,
    name: "Pro",
    description: "For teams building with AI every day.",
    monthlyRecords: 1_000_000,
    retentionDays: 365,
  },
]
export const paymentGraceDays = 7
export const planEntitlements = (plan: CloudPlan) =>
  cloudPlans.find((item) => item.id === plan)!

export type CloudUsage = {
  periodStart: string
  periodEnd: string
  traces: number
  spans: number
  used: number
  limit: number
  remaining: number
  percent: number
  retentionDays: number
}
export const formatUsd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100
  )

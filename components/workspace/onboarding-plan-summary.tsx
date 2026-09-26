import { Check } from "lucide-react"
import Image from "next/image"
import { Skeleton } from "@/components/ui/skeleton"
import {
  cloudPlans,
  formatUsd,
  type CloudPlan,
  type CloudPrices,
} from "@/src/lib/billing"

export function OnboardingPlanSummary({
  plan,
  prices,
  loadingPrice = false,
}: {
  plan: CloudPlan
  prices: CloudPrices | null
  loadingPrice?: boolean
}) {
  const selected = cloudPlans.find((item) => item.id === plan)!
  const benefits = [
    `${selected.monthlyRecords.toLocaleString("en-US")} records per month`,
    `${selected.retentionDays}-day trace retention`,
    "Traces, dashboards, and cost insights",
    "Datasets, scorers, evaluations, and prompts",
    "SDK, CLI, and MCP access",
  ]

  return (
    <section
      aria-label={`${selected.name} plan benefits`}
      className="space-y-8"
    >
      <div className="space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          Datool {selected.name}
        </h2>
        <p className="text-sm leading-relaxed text-foreground-muted">
          {selected.description}
        </p>
      </div>
      {prices ? (
        <p className="text-3xl font-semibold tracking-tight">
          {formatUsd(prices[plan].amount)}
          <span className="text-sm font-normal tracking-normal text-foreground-muted">
            {" "}
            / month
          </span>
        </p>
      ) : loadingPrice ? (
        <Skeleton className="h-9 w-48 bg-background" />
      ) : null}
      <ul className="space-y-4">
        {benefits.map((benefit) => (
          <li
            key={benefit}
            className="flex items-start gap-3 text-sm leading-relaxed"
          >
            <Check
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-foreground-muted"
            />
            <span>{benefit}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-foreground-muted">
        <p>Billed monthly in USD.</p>
        <p className="inline-flex items-center gap-1.5">
          Secure checkout with
          <Image
            src="/stripe-logo.svg"
            alt="Stripe"
            width={48}
            height={20}
            unoptimized
            className="h-5 w-auto"
          />
        </p>
      </div>
    </section>
  )
}

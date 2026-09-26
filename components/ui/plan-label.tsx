import type { ComponentProps } from "react"
import { CircleDashed, Server, Square, Triangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { cloudPlans, type CloudPlan } from "@/src/lib/billing"

export function PlanLabel({
  plan,
  billingEnabled = true,
  className,
  ...props
}: ComponentProps<"span"> & {
  plan: CloudPlan | null
  billingEnabled?: boolean
}) {
  const label = billingEnabled
    ? (cloudPlans.find((item) => item.id === plan)?.name ?? "No plan")
    : "Self-hosted"
  const Icon = !billingEnabled
    ? Server
    : plan === "pro"
      ? Square
      : plan === "core"
        ? Triangle
        : CircleDashed

  return (
    <span
      {...props}
      data-slot="plan-label"
      data-plan={billingEnabled ? (plan ?? "none") : "self-hosted"}
      className={cn(
        "inline-flex shrink-0 items-center gap-2.25 text-lg/6 font-medium text-foreground-muted",
        className
      )}
    >
      <Icon aria-hidden="true" className="size-4.5 fill-foreground/50" />
      {label}
    </span>
  )
}

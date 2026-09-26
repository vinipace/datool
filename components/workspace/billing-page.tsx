"use client"

import { useEffect, useState } from "react"
import { useRemote } from "@/components/tracer/hooks"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { PlanLabel } from "@/components/ui/plan-label"
import { RadioCard } from "@/components/ui/radio-card"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  cloudPlans,
  billingPath,
  formatUsd,
  type CloudPlan,
  type CloudPrices,
  type CloudUsage,
} from "@/src/lib/billing"

type Status = {
  status: string
  plan: CloudPlan | null
  active: boolean
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  hasCustomer: boolean
  graceUntil: string | null
  nextPaymentAttempt: string | null
  usage: CloudUsage
}

const loadBilling = (signal: AbortSignal) =>
  workspaceRequest<Status>("/api/billing/status", { signal })

export function BillingPage({
  organizationName,
  canManage,
  prices,
  initialPlan,
  checkout,
}: {
  organizationName: string
  canManage: boolean
  prices: CloudPrices | null
  initialPlan: CloudPlan
  checkout?: string
}) {
  const router = useRouter()
  const remote = useRemote(loadBilling, [], {
    intervalMs: checkout === "success" ? 5000 : undefined,
    shouldPoll: (data) => !data?.active,
  })
  const status = remote.data
  const loading = remote.isLoading || remote.isRefreshing
  const refresh = remote.refresh
  const [plan, setPlan] = useState(initialPlan)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null)
  const confirming = checkout === "success" && !status?.active

  useEffect(() => {
    if (checkout === "success" && status?.active) router.replace("/projects")
  }, [checkout, status?.active, router])

  async function open(action: "checkout" | "portal") {
    setBusy(action)
    setError("")
    try {
      const result = await workspaceRequest<{ url: string }>(
        `/api/billing/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ plan }),
        }
      )
      window.location.assign(result.url)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to open Stripe. Try again."
      )
      setBusy(null)
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing & usage</h1>
        <p className="mt-2 text-sm text-foreground-muted">
          Cloud subscription for {organizationName}.
        </p>
      </div>
      {error || remote.error ? (
        <Notice variant="error" role="alert">
          {error || remote.error?.message}
        </Notice>
      ) : null}
      {checkout === "canceled" ? (
        <Notice>Checkout canceled. Your subscription has not changed.</Notice>
      ) : null}
      {checkout === "success" && status && !status.active ? (
        <Notice variant="info">
          We’re confirming your subscription with Stripe. This page updates
          automatically; you don’t need to pay again.
        </Notice>
      ) : null}
      {loading && !status ? (
        <Notice role="status">Loading subscription…</Notice>
      ) : null}
      {status ? (
        <div className="rounded-xl border border-border bg-muted p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <PlanLabel plan={status.plan} />
              <h2 className="mt-1 text-xl font-semibold">
                {confirming
                  ? "Confirming your subscription"
                  : status.status === "past_due"
                    ? "Payment overdue"
                    : status.active
                      ? status.status === "trialing"
                        ? "Trial active"
                        : checkout === "success"
                          ? "Your workspace is ready"
                          : "Active"
                      : status.status === "none"
                        ? "Choose a Cloud plan"
                        : status.status
                            .replaceAll("_", " ")
                            .replace(/^./, (letter) => letter.toUpperCase())}
              </h2>
            </div>
            <Button
              size="sm"
              variant="outline"
              loading={loading}
              onClick={() => void refresh()}
            >
              Refresh status
            </Button>
          </div>
          {status.active &&
          status.status !== "past_due" &&
          status.currentPeriodEnd ? (
            <p className="mt-4 text-sm text-foreground-muted">
              {status.cancelAtPeriodEnd
                ? "Access ends"
                : status.active
                  ? "Current period ends"
                  : "Last period ended"}{" "}
              {new Intl.DateTimeFormat("en", {
                dateStyle: "long",
                timeZone: "UTC",
              }).format(new Date(status.currentPeriodEnd))}
              .
            </p>
          ) : null}
          {status.active ? (
            <Button asChild className="mt-5">
              <Link href="/projects">Open workspace</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {status?.status === "past_due" ? (
        <Notice variant="warning">
          {status.active && status.graceUntil
            ? `Your renewal payment failed. Access continues until ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(status.graceUntil))}. Update your payment method before then to avoid an interruption.`
            : status.graceUntil
              ? "The payment grace period has ended. Update your payment method and pay the outstanding invoice to restore access."
              : "Payment is overdue. Update your payment method and pay the outstanding invoice to restore access."}
          {status.nextPaymentAttempt
            ? ` Stripe will retry on ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(status.nextPaymentAttempt))}.`
            : ""}
        </Notice>
      ) : null}
      {status?.usage && status.plan ? (
        <section
          id="usage"
          aria-label="Monthly usage"
          className="space-y-4 rounded-xl border border-border bg-muted p-6"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Monthly usage</h2>
            <p className="text-sm text-foreground-muted">
              Resets{" "}
              {new Intl.DateTimeFormat("en", {
                dateStyle: "medium",
                timeZone: "UTC",
              }).format(new Date(status.usage.periodEnd))}{" "}
              (UTC)
            </p>
          </div>
          <p className="text-2xl font-semibold tabular-nums">
            {status.usage.used.toLocaleString("en-US")}{" "}
            <span className="text-sm font-normal text-foreground-muted">
              / {status.usage.limit.toLocaleString("en-US")} records
            </span>
          </p>
          <p className="text-sm text-foreground-muted">
            {status.usage.traces.toLocaleString("en-US")} traces ·{" "}
            {status.usage.spans.toLocaleString("en-US")} spans ·{" "}
            {status.usage.remaining.toLocaleString("en-US")} remaining
          </p>
          {status.usage.percent >= 80 ? (
            <Notice
              variant={status.usage.remaining === 0 ? "error" : "warning"}
            >
              {status.usage.remaining === 0
                ? "Monthly limit reached. New records are paused; existing data and updates remain available. Upgrade your plan or wait for the monthly reset."
                : `${status.usage.percent}% of your monthly allowance is used. Review your usage before reaching the limit.`}
            </Notice>
          ) : null}
          <p className="text-sm text-foreground-muted">
            Each new trace or span counts once. Updates and retries are free.
            Allowances reset on the first day of each month at 00:00 UTC. No
            overage charges.
          </p>
          <p className="text-sm text-foreground-muted">
            Trace retention: {status.usage.retentionDays} days from receipt.
            Traces saved in datasets, evaluations, or reviews are preserved.
            Shorter retention applies when a downgrade takes effect.
          </p>
        </section>
      ) : null}
      {!canManage ? (
        <Notice>
          Only organization owners and admins can start or manage a
          subscription.
        </Notice>
      ) : (
        <>
          {status &&
          !status.active &&
          !confirming &&
          !["past_due", "unpaid", "paused", "incomplete"].includes(
            status.status
          ) ? (
            <div className="space-y-4">
              {!prices ? (
                <Notice variant="warning">
                  Plan prices are unavailable. Reload this page to try again.
                </Notice>
              ) : (
                <>
                  <fieldset
                    className="grid gap-3 sm:grid-cols-2"
                    aria-label="Cloud plan"
                    disabled={!!busy}
                  >
                    {cloudPlans.map((item) => (
                      <RadioCard
                        key={item.id}
                        name="cloud-plan"
                        value={item.id}
                        checked={plan === item.id}
                        onChange={() => {
                          setPlan(item.id)
                          router.replace(billingPath(item.id), {
                            scroll: false,
                          })
                        }}
                      >
                        <span className="block font-semibold">{item.name}</span>
                        <span className="mt-1 block text-sm">
                          {formatUsd(prices[item.id].amount)}/month
                        </span>
                        <span className="mt-2 block text-xs text-foreground-muted">
                          {item.monthlyRecords.toLocaleString("en-US")} records
                          · {item.retentionDays}-day retention
                        </span>
                      </RadioCard>
                    ))}
                  </fieldset>
                  <Button
                    loading={busy === "checkout"}
                    disabled={!!busy || loading}
                    onClick={() => void open("checkout")}
                  >
                    Subscribe to{" "}
                    {cloudPlans.find((item) => item.id === plan)?.name}
                  </Button>
                  <p className="text-sm text-foreground-muted">
                    Billed monthly in USD.{" "}
                    {prices[plan].trialDays
                      ? `${prices[plan].trialDays}-day trial for first-time subscribers. `
                      : ""}
                    Payment is completed securely with Stripe.
                  </p>
                </>
              )}
            </div>
          ) : null}
          {status?.hasCustomer ? (
            <Button
              variant="outline"
              loading={busy === "portal"}
              disabled={!!busy || loading}
              onClick={() => void open("portal")}
            >
              {status.status === "past_due" || status.status === "unpaid"
                ? "Update payment method"
                : "Manage billing"}
            </Button>
          ) : null}
        </>
      )}
      {!status && !loading ? (
        <Button variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link
          className="text-foreground-muted hover:text-foreground"
          href="/pricing"
        >
          View pricing
        </Link>
        <Link
          className="text-foreground-muted hover:text-foreground"
          href={`/?${new URLSearchParams({ returnTo: billingPath(plan) })}`}
        >
          Switch organization
        </Link>
      </div>
    </section>
  )
}

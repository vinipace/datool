"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowUpRight, KeyRound, Plus } from "lucide-react"

import datoolLogo from "@/app/icon.svg"
import { formatDashboardValue } from "@/components/tracer/dashboard-utils"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardFooter } from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import { PlanLabel } from "@/components/ui/plan-label"
import type { CloudPlan } from "@/src/lib/billing"
import { authClient } from "@/lib/auth-client"
import {
  navigateWorkspace,
  selectOrganization,
} from "@/lib/workspace-selection"

export type OrganizationListItem = {
  id: string
  name: string
  slug: string
  createdAt: string
  projectCount: number
  traceCount: number
  plan: CloudPlan | null
}

function errorMessage(value: unknown) {
  if (value && typeof value === "object" && "message" in value) {
    return String(value.message)
  }
  return "Unable to select the organization. Try again."
}

export function OrganizationsPage({
  initialOrganizations,
  destination = "/projects",
  billingEnabled = true,
}: {
  destination?: string
  billingEnabled?: boolean
  initialOrganizations: OrganizationListItem[]
}) {
  const router = useRouter()
  const organizations = initialOrganizations
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  async function signOut() {
    await authClient.signOut()
    router.replace("/sign-in")
    router.refresh()
  }

  async function openOrganization(organization: OrganizationListItem) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await selectOrganization(organization.id)
      navigateWorkspace(destination)
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  async function openOrganizationSettings(organization: OrganizationListItem) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await selectOrganization(organization.id)
      navigateWorkspace("/api-keys")
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-svh flex-col bg-surface-canvas text-foreground">
      <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <div className="mr-auto flex items-center gap-3">
          <Image
            src={datoolLogo}
            alt="Datool"
            width={28}
            height={28}
            unoptimized
            className="size-7 shrink-0"
          />
          <div>
            <h1 className="text-sm font-semibold">Organizations</h1>
            <p className="text-xs text-foreground-muted">
              {organizations.length} available
            </p>
          </div>
        </div>
        <Button
          asChild
          size="sm"
          className="order-last w-full sm:order-none sm:w-auto"
        >
          <Link href="/organizations/new">
            <Plus aria-hidden="true" />
            New organization
          </Link>
        </Button>
        <Button onClick={() => void signOut()} size="sm" variant="ghost">
          Sign out
        </Button>
      </header>
      {error ? (
        <Notice layout="banner" variant="error" role="alert">
          {error}
        </Notice>
      ) : null}
      <section aria-label="Organizations" className="flex-1 p-4 sm:p-6">
        {organizations.length ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {organizations.map((organization) => (
              <li className="min-w-0" key={organization.id}>
                <Card className="h-full">
                  <CardAction
                    aria-label={`Open ${organization.name}`}
                    disabled={busy}
                    onClick={() => void openOrganization(organization)}
                  >
                    <span className="flex min-w-0 items-start justify-between gap-3">
                      <span className="grid min-w-0 gap-1">
                        <span className="truncate text-xl font-semibold">
                          {organization.name}
                        </span>
                        <span
                          className="text-sm text-foreground-muted tabular-nums"
                          title={`${organization.traceCount.toLocaleString("en-US")} ${organization.traceCount === 1 ? "trace" : "traces"}`}
                        >
                          {formatDashboardValue(
                            organization.traceCount,
                            undefined,
                            "compact"
                          )}{" "}
                          {organization.traceCount === 1 ? "trace" : "traces"}
                        </span>
                      </span>
                      <ArrowUpRight
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-foreground-muted"
                      />
                    </span>
                    <span className="text-sm text-foreground-muted">
                      <span className="font-medium text-foreground tabular-nums">
                        {organization.projectCount}
                      </span>{" "}
                      {organization.projectCount === 1 ? "project" : "projects"}
                    </span>
                  </CardAction>
                  <CardFooter className="flex-wrap justify-between gap-2 border-t border-border px-5 py-3">
                    <PlanLabel
                      plan={organization.plan}
                      billingEnabled={billingEnabled}
                    />
                    <Button
                      aria-label={`API keys for ${organization.name}`}
                      disabled={busy}
                      onClick={() =>
                        void openOrganizationSettings(organization)
                      }
                      size="sm"
                      variant="ghost-muted"
                    >
                      <KeyRound aria-hidden="true" className="size-3.5" />
                      API keys
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
            Create an organization to get started.
          </Card>
        )}
      </section>
    </main>
  )
}

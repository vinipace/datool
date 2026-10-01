"use client"

import { useCallback } from "react"
import Link from "next/link"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import { DonutProgress } from "@/components/ui/donut-progress"
import { SegmentedProgress } from "@/components/ui/segmented-progress"
import { Skeleton } from "@/components/ui/skeleton"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useRemote } from "@/components/tracer/hooks"
import {
  workspaceRequest,
  type WorkspaceOrganization,
} from "@/lib/workspace-api"
import { formatCredits, type ExecutionUsage } from "@/src/lib/execution-credits"
import type { CloudPlan, CloudUsage } from "@/src/lib/billing"

export type OrganizationUsage = {
  credits: ExecutionUsage
  records: CloudUsage
  plan: CloudPlan | null
}
const number = (value: number) => new Intl.NumberFormat("en-US").format(value)
const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(value))
    : "—"
export function UsagePage({
  organization,
}: {
  organization: WorkspaceOrganization
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<OrganizationUsage>(
        `/api/organizations/${encodeURIComponent(organization.id)}/usage`,
        { signal }
      ),
    [organization.id]
  )
  const remote = useRemote(load, [organization.id])
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Organization usage</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Shared across every project in {organization.name}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={remote.refresh}
            loading={remote.isRefreshing}
          >
            <RefreshCw />
            Refresh
          </Button>
          <Button asChild size="sm" variant="secondary">
            <Link href="/billing">Manage plan</Link>
          </Button>
        </div>
      </div>
      {remote.error && (
        <Notice role="alert" variant="error">
          {remote.error.message}{" "}
          <Button size="sm" variant="outline" onClick={remote.refresh}>
            Retry usage
          </Button>
        </Notice>
      )}
      {remote.isLoading ? (
        <div
          role="status"
          aria-label="Loading usage"
          className="grid gap-4 md:grid-cols-2"
        >
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        remote.data && <UsageDetails data={remote.data} />
      )}
    </div>
  )
}
export function UsageDetails({ data }: { data: OrganizationUsage }) {
  const { credits, records, plan } = data
  const segments = [
    {
      label: "Model scorers",
      value: credits.model,
      className: "text-comparison-1",
    },
    {
      label: "Sandboxes",
      value: credits.sandbox,
      className: "text-comparison-2",
    },
    {
      label: "Reserved",
      value: credits.reserved,
      className: "text-foreground-muted",
    },
  ]
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Execution credits</CardTitle>
            <CardDescription>
              {plan
                ? `${plan === "pro" ? "Pro" : "Core"} · Monthly USD balance`
                : "Included with paid Core and Pro plans"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-center gap-6">
              <DonutProgress
                className="size-32"
                trackClassName="text-border"
                value={credits.used + credits.reserved}
                max={credits.allowance}
                label="Execution credit usage"
                valueText={`${formatCredits(credits.used)} used; ${formatCredits(credits.reserved)} reserved; ${formatCredits(credits.remaining)} remaining`}
                segments={segments}
              />
              <div>
                <p className="text-3xl font-semibold tabular-nums">
                  {formatCredits(credits.remaining)}
                </p>
                <p className="mt-1 text-sm text-foreground-muted">
                  remaining of {formatCredits(credits.allowance)}
                </p>
                <p className="mt-3 text-xs text-foreground-muted">
                  {credits.periodEnd
                    ? `Renews ${date(credits.periodEnd)} · UTC`
                    : "Credits start with your first paid billing period"}
                </p>
              </div>
            </div>
            <dl className="space-y-3">
              {segments.map((segment) => (
                <div
                  key={segment.label}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <dt className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 rounded-full bg-current ${segment.className}`}
                    />
                    {segment.label}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatCredits(segment.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Plan usage</CardTitle>
            <CardDescription>
              {date(records.periodStart)} – {date(records.periodEnd)} · Records
              reset monthly in UTC
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-7 pt-6">
            <UsageMeter
              label="Records"
              value={records.used}
              max={records.limit}
              detail={`${number(records.used)} / ${number(records.limit)}`}
            />
            <UsageMeter
              label="Execution credits committed"
              tone="text-comparison-2"
              value={credits.used + credits.reserved}
              max={credits.allowance}
              detail={`${formatCredits(credits.used + credits.reserved)} / ${formatCredits(credits.allowance)}`}
            />
            <div className="grid grid-cols-3 gap-3 border-t border-border pt-5 text-sm">
              <div>
                <p className="text-foreground-muted">Traces</p>
                <p className="mt-1 tabular-nums">{number(records.traces)}</p>
              </div>
              <div>
                <p className="text-foreground-muted">Spans</p>
                <p className="mt-1 tabular-nums">{number(records.spans)}</p>
              </div>
              <div>
                <p className="text-foreground-muted">Retention</p>
                <p className="mt-1">{records.retentionDays} days</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      {credits.allowance > 0 && credits.remaining === 0 && (
        <Notice role="status">
          Your execution credits are fully used or reserved. Funded runs resume
          with the next paid period. You can also select your own provider in
          project settings.
        </Notice>
      )}
      {credits.pendingRuns > 0 && (
        <Notice>
          {number(credits.pendingRuns)} runs have reserved credits. Completed
          runs release the unused amount. Unconfirmed provider usage stays
          reserved until reconciled.
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Usage by project</CardTitle>
          <CardDescription>
            Datool Scorer Model and Datool Sandbox share the same balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-5">
          {credits.projects.length ? (
            <div className="overflow-x-auto">
              <table className={`${collectionTable.table} min-w-96`}>
                <thead className={collectionTable.head}>
                  <tr>
                    <th scope="col" className={collectionTable.heading}>
                      Project
                    </th>
                    <th
                      scope="col"
                      className={`${collectionTable.heading} text-right`}
                    >
                      Scorers
                    </th>
                    <th
                      scope="col"
                      className={`${collectionTable.heading} text-right`}
                    >
                      Sandboxes
                    </th>
                    <th
                      scope="col"
                      className={`${collectionTable.heading} text-right`}
                    >
                      Reserved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {credits.projects.map((project) => (
                    <tr
                      key={project.id}
                      className={`${collectionTable.row} cursor-default`}
                    >
                      <td className={`${collectionTable.cell} font-medium`}>
                        {project.name}
                      </td>
                      <td
                        className={`${collectionTable.cell} text-right tabular-nums`}
                      >
                        {formatCredits(project.model)}
                      </td>
                      <td
                        className={`${collectionTable.cell} text-right tabular-nums`}
                      >
                        {formatCredits(project.sandbox)}
                      </td>
                      <td
                        className={`${collectionTable.cell} text-right tabular-nums`}
                      >
                        {formatCredits(project.reserved)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-foreground-muted">
              No funded runs this period. Select Datool Scorer Model or Datool
              Sandbox in a project to get started.
            </p>
          )}
        </CardContent>
      </Card>
      <p className="text-xs leading-relaxed text-foreground-muted">
        Credits expire at the end of the paid period and do not roll over.
        Funded runs stop when the available balance is insufficient; no
        automatic overage charges apply. Usage with your own provider keys is
        billed by that provider and is not deducted here.
      </p>
    </>
  )
}
function UsageMeter({
  label,
  value,
  max,
  detail,
  tone = "text-comparison-1",
}: {
  label: string
  value: number
  max: number
  detail: string
  tone?: string
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="text-foreground-muted tabular-nums">{detail}</span>
      </div>
      <SegmentedProgress
        variant="dashed"
        className="h-6"
        label={label}
        value={value}
        max={max}
        valueText={detail}
        segments={[{ label, value, className: tone }]}
      />
    </div>
  )
}

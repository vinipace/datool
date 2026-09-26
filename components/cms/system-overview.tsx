"use client"

import { useState, useTransition, type ChangeEvent } from "react"
import { useRouter } from "next/navigation"
import { Banner, Button, Link, TextInput } from "@payloadcms/ui"
import {
  subscriptionStatuses,
  formatCount,
  formatDate,
  formatMonth,
  systemHref,
  type SystemFilters,
  type SystemOrganization,
  type SystemOrganizationDetail,
  type SystemOverview,
} from "@/src/lib/system-overview"
import {
  SubscriptionStatus,
  SystemStats,
  SystemSelect,
  SystemTable,
  UsageHistory,
  UsageQuota,
} from "@/components/ui/cms-system"
import styles from "@/components/ui/cms-system.module.css"

const detailHref = (id: string) =>
  `/cms/organizations/${encodeURIComponent(id)}`
const planName = (plan: string | null) =>
  plan ? plan[0].toUpperCase() + plan.slice(1) : "—"
const identity = (row: SystemOrganization) => (
  <div className={styles.identity}>
    <Link title={row.name} href={detailHref(row.id)}>
      {row.name}
    </Link>
    <small>{row.slug}</small>
  </div>
)

function StripeLink({
  row,
  base,
}: {
  row: SystemOrganization
  base: string | null
}) {
  const path =
    row.subscriptionId && /^sub_[a-zA-Z0-9]+$/.test(row.subscriptionId)
      ? `subscriptions/${row.subscriptionId}`
      : row.customerId && /^cus_[a-zA-Z0-9]+$/.test(row.customerId)
        ? `customers/${row.customerId}`
        : null
  return base && path ? (
    <a href={`${base}/${path}`} target="_blank" rel="noreferrer">
      Open Stripe ↗
    </a>
  ) : (
    <span className={styles.muted}>—</span>
  )
}

function SystemFilterBar({
  filters,
  usage,
  currentMonth,
}: {
  filters: SystemFilters
  usage: boolean
  currentMonth: string
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(filters)
  const [pending, startTransition] = useTransition()
  const path = usage ? "/cms/usage" : "/cms/subscriptions"
  const months = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(`${currentMonth}-01T00:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() - index)
    const value = date.toISOString().slice(0, 7)
    return { label: formatMonth(value), value }
  })
  if (!months.some((month) => month.value === filters.month))
    months.push({ label: formatMonth(filters.month), value: filters.month })
  const select = (
    key: "status" | "plan" | "month" | "sort",
    label: string,
    options: { label: string; value: string }[]
  ) => (
    <SystemSelect
      label={label}
      value={draft[key]}
      options={options}
      disabled={pending}
      onChange={(value) => setDraft({ ...draft, [key]: value })}
    />
  )
  return (
    <form
      className={styles.toolbar}
      aria-label="Organization filters"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(() => router.push(systemHref(path, draft, 1)))
      }}
    >
      <TextInput
        path="system-search"
        label="Search organizations"
        placeholder="Name, slug, or ID"
        value={draft.q}
        readOnly={pending}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          setDraft({ ...draft, q: event.target.value })
        }
      />
      {select("plan", "Plan", [
        { label: "All plans", value: "all" },
        { label: "Core", value: "core" },
        { label: "Pro", value: "pro" },
        { label: "No plan", value: "none" },
      ])}
      {select("status", "Status", [
        { label: "All statuses", value: "all" },
        ...subscriptionStatuses.map((value) => ({
          value,
          label:
            value === "none" ? "No subscription" : value.replaceAll("_", " "),
        })),
      ])}
      {usage && select("month", "Month (UTC)", months)}
      {usage &&
        select("sort", "Sort", [
          { label: "Most usage", value: "usage" },
          { label: "Organization name", value: "name" },
        ])}
      <Button type="submit" size="small" margin={false} disabled={pending}>
        {pending ? "Loading…" : "Apply filters"}
      </Button>
      <Button
        el="link"
        to={path}
        buttonStyle="secondary"
        size="small"
        margin={false}
      >
        Reset
      </Button>
    </form>
  )
}

function SnapshotNote({
  billingEnabled,
  capturedAt,
}: {
  billingEnabled: boolean
  capturedAt: string
}) {
  return (
    <p className={styles.muted}>
      Read-only snapshot ·{" "}
      {new Date(capturedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.{" "}
      Activity counts retained traces and spans by their start time. Deleted
      records are excluded. Billing quota usage is counted separately.{" "}
      {billingEnabled
        ? "Billing counters include records received while Cloud billing was enabled."
        : "Cloud billing is disabled; activity is still available."}
    </p>
  )
}

export function SystemOverviewPage({
  data,
  view,
}: {
  data: SystemOverview
  view: "subscriptions" | "usage"
}) {
  const usage = view === "usage"
  const path = `/cms/${view}`
  const currentPeriod = data.filters.month === data.currentMonth
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <h1>{usage ? "Organization usage" : "Subscriptions"}</h1>
          <p>
            {usage
              ? `Stored activity for ${formatMonth(data.filters.month)} by start time (UTC). One trace or span counts as one record.`
              : "Subscription status across all organizations. Manage changes in Stripe."}
          </p>
        </div>
        <Button
          el="link"
          to={usage ? "/cms/subscriptions" : "/cms/usage"}
          buttonStyle="secondary"
          size="small"
          margin={false}
        >
          {usage ? "View subscriptions" : "View usage"}
        </Button>
      </header>
      <SystemStats
        items={
          usage
            ? [
                { label: "Stored records", value: data.summary.used },
                { label: "Traces", value: data.summary.traces },
                { label: "Spans", value: data.summary.spans },
                {
                  label: "Organizations with activity",
                  value: data.summary.activeOrganizations,
                },
              ]
            : [
                { label: "Organizations", value: data.total },
                { label: "Active subscriptions", value: data.summary.active },
                { label: "Past due", value: data.summary.pastDue },
                {
                  label: "Scheduled cancellations",
                  value: data.summary.canceling,
                },
              ]
        }
      />
      <SystemFilterBar
        key={JSON.stringify(data.filters)}
        filters={data.filters}
        usage={usage}
        currentMonth={data.currentMonth}
      />
      <p className={styles.muted}>
        {data.total} matching organization{data.total === 1 ? "" : "s"}. Summary
        totals include every matching organization.
      </p>
      <SystemTable
        rows={data.rows}
        columns={
          usage
            ? [
                { key: "organization", label: "Organization", cell: identity },
                {
                  key: "plan",
                  label: "Current plan",
                  cell: (row) => planName(row.plan),
                },
                {
                  key: "traces",
                  label: "Traces",
                  cell: (row) => formatCount(row.traces),
                },
                {
                  key: "spans",
                  label: "Spans",
                  cell: (row) => formatCount(row.spans),
                },
                {
                  key: "records",
                  label: "Stored records",
                  cell: (row) => <strong>{formatCount(row.used)}</strong>,
                },
                ...(currentPeriod
                  ? [
                      {
                        key: "quota",
                        label: "Billing quota",
                        cell: (row: SystemOrganization) => (
                          <UsageQuota
                            used={row.meteredUsed}
                            limit={row.recordLimit}
                          />
                        ),
                      },
                    ]
                  : []),
              ]
            : [
                { key: "organization", label: "Organization", cell: identity },
                {
                  key: "plan",
                  label: "Plan",
                  cell: (row) => planName(row.plan),
                },
                {
                  key: "status",
                  label: "Status",
                  cell: (row) => <SubscriptionStatus status={row.status} />,
                },
                {
                  key: "renewal",
                  label: "Period ends",
                  cell: (row) => (
                    <>
                      {formatDate(row.periodEnd)}
                      {row.cancelAtPeriodEnd && (
                        <small className={styles.identity}>
                          Cancellation scheduled
                        </small>
                      )}
                    </>
                  ),
                },
                {
                  key: "synced",
                  label: "Last Stripe sync",
                  cell: (row) =>
                    row.syncedAt ? (
                      <time title={row.syncedAt}>
                        {formatDate(row.syncedAt)}
                        {Date.parse(data.capturedAt) -
                          Date.parse(row.syncedAt) >
                          300000 && (
                          <small className={styles.identity}>
                            May be out of date
                          </small>
                        )}
                      </time>
                    ) : (
                      "Never synced"
                    ),
                },
                {
                  key: "stripe",
                  label: "Stripe",
                  cell: (row) => (
                    <StripeLink row={row} base={data.stripeBase} />
                  ),
                },
              ]
        }
      />
      <nav className={styles.pagination} aria-label="Organization pagination">
        <span>
          Page {data.filters.page} of {data.pages}
        </span>
        <div className={styles.actions}>
          {data.filters.page > 1 && (
            <Button
              el="link"
              to={systemHref(path, data.filters, data.filters.page - 1)}
              buttonStyle="secondary"
              size="small"
              margin={false}
            >
              Previous
            </Button>
          )}
          {data.filters.page < data.pages && (
            <Button
              el="link"
              to={systemHref(path, data.filters, data.filters.page + 1)}
              buttonStyle="secondary"
              size="small"
              margin={false}
            >
              Next
            </Button>
          )}
        </div>
      </nav>
      {usage && (
        <>
          <UsageHistory months={data.history} capturedAt={data.capturedAt} />
          <p className={styles.muted}>
            History follows the current organization, plan, and status filters.
            Historical plan limits are not recorded, so quota percentages are
            shown only for the current month.
          </p>
        </>
      )}
      <SnapshotNote {...data} />
    </div>
  )
}

export function SystemOrganizationPage({
  data,
}: {
  data: SystemOrganizationDetail
}) {
  const row = data.organization
  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div>
          <h1>{row.name}</h1>
          <p className={styles.muted}>
            {row.slug} · Created {formatDate(row.createdAt)}
          </p>
        </div>
        <Button
          el="link"
          to="/cms/subscriptions"
          buttonStyle="secondary"
          size="small"
          margin={false}
        >
          All organizations
        </Button>
      </header>
      <SystemStats
        items={[
          { label: "Members", value: row.members },
          { label: "Projects", value: row.projects },
          {
            label: `Stored records · ${formatMonth(data.currentMonth)}`,
            value: row.used,
          },
          { label: "Current monthly limit", value: row.recordLimit },
        ]}
      />
      <section className={styles.section}>
        <h2>Subscription</h2>
        <dl className={styles.details}>
          <div>
            <dt>Status</dt>
            <dd>
              <SubscriptionStatus status={row.status} />
            </dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{planName(row.plan)}</dd>
          </div>
          <div>
            <dt>Period ends</dt>
            <dd>
              {formatDate(row.periodEnd)}
              {row.cancelAtPeriodEnd ? " · Cancellation scheduled" : ""}
            </dd>
          </div>
          <div>
            <dt>Payment grace ends</dt>
            <dd>{formatDate(row.graceUntil)}</dd>
          </div>
          <div>
            <dt>Next payment attempt</dt>
            <dd>{formatDate(row.nextPaymentAttempt)}</dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>
              {row.retentionDays === null ? "—" : `${row.retentionDays} days`}
            </dd>
          </div>
          <div>
            <dt>Last Stripe sync (UTC)</dt>
            <dd>
              {row.syncedAt
                ? row.syncedAt.slice(0, 16).replace("T", " ")
                : "Never synced"}
            </dd>
          </div>
          <div>
            <dt>Stripe</dt>
            <dd>
              <StripeLink row={row} base={data.stripeBase} />
            </dd>
          </div>
          <div>
            <dt>Organization ID</dt>
            <dd>{row.id}</dd>
          </div>
          <div>
            <dt>Customer ID</dt>
            <dd>{row.customerId ?? "—"}</dd>
          </div>
          <div>
            <dt>Subscription ID</dt>
            <dd>{row.subscriptionId ?? "—"}</dd>
          </div>
          <div>
            <dt>Billing quota used</dt>
            <dd>
              <UsageQuota used={row.meteredUsed} limit={row.recordLimit} />
            </dd>
          </div>
        </dl>
      </section>
      <UsageHistory months={data.history} capturedAt={data.capturedAt} />
      <section>
        <h2>Projects</h2>
        {row.projects > data.projects.length && (
          <p className={styles.muted}>
            Showing the first {data.projects.length} of {row.projects} projects.
          </p>
        )}
        <SystemTable
          rows={data.projects}
          empty="This organization has no projects."
          columns={[
            { key: "name", label: "Project", cell: (project) => project.name },
            { key: "slug", label: "Slug", cell: (project) => project.slug },
            { key: "id", label: "Project ID", cell: (project) => project.id },
            {
              key: "created",
              label: "Created",
              cell: (project) => formatDate(project.createdAt),
            },
          ]}
        />
      </section>
      <SnapshotNote {...data} />
    </div>
  )
}

export function SystemDataError() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <div className={styles.page}>
      <h1>System overview</h1>
      <Banner type="error">
        Unable to load system data. Please try again.
      </Banner>
      <div>
        <Button
          size="small"
          margin={false}
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          {pending ? "Loading…" : "Retry"}
        </Button>
      </div>
    </div>
  )
}

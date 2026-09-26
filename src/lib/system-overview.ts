export const subscriptionStatuses = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
  "none",
] as const

export const formatCount = (value: number | null) =>
  value === null ? "Not recorded" : new Intl.NumberFormat("en-US").format(value)
export const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(value))
    : "—"
export const formatMonth = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T00:00:00Z`))

export type SystemFilters = {
  q: string
  status: string
  plan: string
  month: string
  page: number
  sort: "name" | "usage"
}

export function systemFilters(
  params: Record<string, unknown> = {},
  now = new Date()
): SystemFilters {
  const currentMonth = now.toISOString().slice(0, 7)
  const text = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : ""
  const month = text("month")
  return {
    q: text("q").trim().slice(0, 120),
    status: subscriptionStatuses.some((status) => status === text("status"))
      ? text("status")
      : "all",
    plan: ["core", "pro", "none"].includes(text("plan")) ? text("plan") : "all",
    month:
      /^20\d{2}-(0[1-9]|1[0-2])$/.test(month) && month <= currentMonth
        ? month
        : currentMonth,
    page: Math.min(
      1000000,
      Math.max(1, Number.parseInt(text("page"), 10) || 1)
    ),
    sort: text("sort") === "usage" ? "usage" : "name",
  }
}

export function systemHref(
  path: string,
  filters: SystemFilters,
  page = filters.page
) {
  const query = new URLSearchParams({ ...filters, page: String(page) })
  return `${path}?${query}`
}

export type SystemOrganization = {
  id: string
  name: string
  slug: string
  createdAt: string
  plan: string | null
  status: string
  periodEnd: string | null
  cancelAtPeriodEnd: boolean
  syncedAt: string | null
  graceUntil: string | null
  nextPaymentAttempt: string | null
  customerId: string | null
  subscriptionId: string | null
  recordLimit: number | null
  retentionDays: number | null
  traces: number
  spans: number
  used: number
  meteredUsed: number | null
  members: number
  projects: number
}

export type UsageMonth = {
  month: string
  traces: number
  spans: number
  used: number
  organizations: number
}

export type SystemOverview = {
  filters: SystemFilters
  currentMonth: string
  capturedAt: string
  billingEnabled: boolean
  stripeBase: string | null
  rows: SystemOrganization[]
  total: number
  pages: number
  summary: {
    active: number
    pastDue: number
    canceling: number
    activeOrganizations: number
    traces: number
    spans: number
    used: number
  }
  history: UsageMonth[]
}

export type SystemOrganizationDetail = {
  organization: SystemOrganization
  currentMonth: string
  capturedAt: string
  billingEnabled: boolean
  stripeBase: string | null
  history: UsageMonth[]
  projects: { id: string; name: string; slug: string; createdAt: string }[]
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, userEvent, within } from "storybook/test"
import type { SystemOverview } from "@/src/lib/system-overview"
import {
  SystemDataError,
  SystemOrganizationPage,
  SystemOverviewPage,
} from "./system-overview"

const data: SystemOverview = {
  filters: {
    q: "",
    status: "all",
    plan: "all",
    month: "2026-09",
    page: 1,
    sort: "name",
  },
  currentMonth: "2026-09",
  capturedAt: "2026-09-22T12:00:00Z",
  billingEnabled: true,
  stripeBase: "https://dashboard.stripe.com/test",
  total: 30,
  pages: 2,
  summary: {
    active: 1,
    pastDue: 1,
    canceling: 0,
    activeOrganizations: 1,
    traces: 10000,
    spans: 70000,
    used: 80000,
  },
  rows: [
    {
      id: "org-1",
      name: "Acme AI",
      slug: "acme",
      createdAt: "2026-08-01T00:00:00Z",
      plan: "core",
      status: "active",
      periodEnd: "2026-10-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      syncedAt: "2026-09-22T11:59:00Z",
      graceUntil: null,
      nextPaymentAttempt: null,
      customerId: "cus_demo",
      subscriptionId: "sub_demo",
      recordLimit: 100000,
      retentionDays: 90,
      traces: 10000,
      spans: 70000,
      used: 80000,
      meteredUsed: 40000,
      members: 3,
      projects: 2,
    },
    {
      id: "org-2",
      name: "New team",
      slug: "new-team",
      createdAt: "2026-09-20T00:00:00Z",
      plan: null,
      status: "none",
      periodEnd: null,
      cancelAtPeriodEnd: false,
      syncedAt: null,
      graceUntil: null,
      nextPaymentAttempt: null,
      customerId: null,
      subscriptionId: null,
      recordLimit: null,
      retentionDays: null,
      traces: 0,
      spans: 0,
      used: 0,
      meteredUsed: null,
      members: 1,
      projects: 0,
    },
  ],
  history: [
    {
      month: "2026-06",
      traces: 0,
      spans: 0,
      used: 0,
      organizations: 0,
    },
    {
      month: "2026-07",
      traces: 0,
      spans: 0,
      used: 0,
      organizations: 0,
    },
    {
      month: "2026-08",
      traces: 1000,
      spans: 3000,
      used: 4000,
      organizations: 1,
    },
    {
      month: "2026-09",
      traces: 10000,
      spans: 70000,
      used: 80000,
      organizations: 1,
    },
  ],
}

const meta = {
  title: "CMS/System oversight",
  component: SystemOverviewPage,
  args: { data, view: "subscriptions" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SystemOverviewPage>
export default meta
type Story = StoryObj<typeof meta>

export const Subscriptions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("link", { name: "Acme AI" })).toHaveAttribute(
      "href",
      "/cms/organizations/org-1"
    )
    await expect(
      canvas.getByRole("link", { name: /Open Stripe/ })
    ).toHaveAttribute(
      "href",
      "https://dashboard.stripe.com/test/subscriptions/sub_demo"
    )
    await expect(
      canvas.queryByRole("button", { name: /cancel|change plan|save/i })
    ).not.toBeInTheDocument()
    const search = canvas.getByLabelText("Search organizations")
    await userEvent.type(search, "Acme")
    getRouter().push.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Apply filters" }))
    await expect(getRouter().push).toHaveBeenCalledWith(
      expect.stringContaining("q=Acme")
    )
    await expect(canvas.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      expect.stringContaining("page=2")
    )
  },
}
export const Usage: Story = {
  args: { view: "usage" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("40% of 100,000")).toBeVisible()
    await expect(canvas.queryByText("Not recorded")).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("region", { name: "Monthly usage history" })
    ).toBeVisible()
    const history = within(
      canvas.getByRole("region", { name: "Monthly usage history" })
    )
    const chart = history.getByRole("application")
    chart.focus()
    await expect(history.findByText("2026-06")).resolves.toBeVisible()
    await expect(
      history.getAllByText("0", { selector: "strong" })
    ).toHaveLength(2)
    await userEvent.keyboard("{ArrowRight}")
    await expect(history.findByText("2026-07")).resolves.toBeVisible()
    await expect(
      history.getAllByText("0", { selector: "strong" })
    ).toHaveLength(2)
    await userEvent.keyboard("{ArrowRight}")
    await expect(history.findByText("1,000")).resolves.toBeVisible()
    await expect(history.getByText("3,000")).toBeVisible()
  },
}
export const UsageWithoutBilling: Story = {
  args: {
    view: "usage",
    data: {
      ...data,
      billingEnabled: false,
      rows: [
        { ...data.rows[1], traces: 120, spans: 360, used: 480, projects: 1 },
      ],
      total: 1,
      pages: 1,
      summary: {
        active: 0,
        pastDue: 0,
        canceling: 0,
        activeOrganizations: 1,
        traces: 120,
        spans: 360,
        used: 480,
      },
      history: data.history.map((month) => ({
        ...month,
        traces: month.month === "2026-09" ? 120 : 0,
        spans: month.month === "2026-09" ? 360 : 0,
        used: month.month === "2026-09" ? 480 : 0,
        organizations: month.month === "2026-09" ? 1 : 0,
      })),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = canvas.getByRole("row", { name: /New team/ })
    await expect(within(row).getByText("120")).toBeVisible()
    await expect(within(row).getByText("360")).toBeVisible()
    await expect(within(row).getByText("480")).toBeVisible()
    await expect(
      canvas.getByText(/Cloud billing is disabled; activity is still available/)
    ).toBeVisible()
    await expect(canvas.queryByText("Not recorded")).not.toBeInTheDocument()
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument()
  },
}
export const HistoricalUsage: Story = {
  args: {
    view: "usage",
    data: { ...data, filters: { ...data.filters, month: "2026-08" } },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByText("Billing quota")
    ).not.toBeInTheDocument()
  },
}
export const Empty: Story = {
  args: {
    data: {
      ...data,
      total: 0,
      pages: 1,
      rows: [],
      summary: {
        active: 0,
        pastDue: 0,
        canceling: 0,
        activeOrganizations: 0,
        traces: 0,
        spans: 0,
        used: 0,
      },
    },
  },
}
export const Organization: Story = {
  render: () => (
    <SystemOrganizationPage
      data={{
        ...data,
        organization: data.rows[0],
        projects: [
          {
            id: "project-1",
            name: "Assistant",
            slug: "assistant",
            createdAt: "2026-08-01T00:00:00Z",
          },
        ],
      }}
    />
  ),
}
export const Failure: Story = {
  render: () => <SystemDataError />,
  play: async ({ canvasElement }) => {
    getRouter().refresh.mockClear()
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Retry" })
    )
    await expect(getRouter().refresh).toHaveBeenCalled()
  },
}

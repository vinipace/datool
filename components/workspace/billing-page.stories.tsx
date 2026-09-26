import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { waitFor, expect, userEvent, within } from "storybook/test"
import { BillingPage } from "./billing-page"

const unpaid = {
  status: "none",
  plan: null,
  active: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  hasCustomer: false,
}
const activeUsage = {
  ...unpaid,
  status: "active",
  plan: "core",
  active: true,
  hasCustomer: true,
  graceUntil: null,
  nextPaymentAttempt: null,
  usage: {
    periodStart: "2026-09-01T00:00:00Z",
    periodEnd: "2026-10-01T00:00:00Z",
    traces: 20000,
    spans: 65000,
    used: 85000,
    limit: 100000,
    remaining: 15000,
    percent: 85,
    retentionDays: 90,
  },
}
const status = (value = unpaid) =>
  http.get("/api/billing/status", () => HttpResponse.json(value))
const meta = {
  title: "Workspace/BillingPage",
  component: BillingPage,
  args: {
    organizationName: "Datool demo",
    canManage: true,
    prices: {
      core: { amount: 2900, currency: "usd", trialDays: 0 },
      pro: { amount: 19900, currency: "usd", trialDays: 0 },
    },
    initialPlan: "core",
  },
  parameters: { layout: "fullscreen", msw: { handlers: [status()] } },
} satisfies Meta<typeof BillingPage>
export default meta
type Story = StoryObj<typeof meta>

export const ProSelected: Story = {
  args: { initialPlan: "pro", checkout: "canceled" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("radio", { name: /^Pro / })
    ).resolves.toBeChecked()
    await expect(
      canvas.getByRole("button", { name: "Subscribe to Pro" })
    ).toBeEnabled()
    await expect(canvas.getByText(/Checkout canceled/)).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Switch organization" })
    ).toHaveAttribute("href", "/?returnTo=%2Fbilling%3Fplan%3Dpro")
  },
}

export const ConfirmingPayment: Story = {
  beforeEach: () => {
    getRouter().replace.mockClear()
  },
  args: { initialPlan: "pro", checkout: "success" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Confirming your subscription" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /Subscribe to/ })
    ).not.toBeInTheDocument()
    await expect(canvas.getByText(/don’t need to pay again/)).toBeVisible()
    await expect(getRouter().replace).not.toHaveBeenCalled()
  },
}

export const PaymentConfirmed: Story = {
  beforeEach: () => {
    getRouter().replace.mockClear()
  },
  args: { initialPlan: "pro", checkout: "success" },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () =>
          HttpResponse.json({ ...activeUsage, plan: "pro" })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Your workspace is ready" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Open workspace" })
    ).toBeVisible()
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith("/projects")
    )
  },
}

export const ChoosePlan: Story = {
  parameters: {
    msw: {
      handlers: [
        status(),
        http.post("/api/billing/checkout", () =>
          HttpResponse.json(
            {
              error: {
                message:
                  "Billing is temporarily unavailable. Please try again shortly.",
              },
            },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Choose a Cloud plan" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("radio", { name: /^Pro / }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Subscribe to Pro" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Billing is temporarily unavailable"
    )
    await expect(
      canvas.getByRole("button", { name: "Subscribe to Pro" })
    ).toBeEnabled()
  },
}
export const ScheduledCancellation: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () =>
          HttpResponse.json({
            ...unpaid,
            status: "active",
            plan: "core",
            active: true,
            hasCustomer: true,
            currentPeriodEnd: "2026-10-22T00:00:00Z",
            cancelAtPeriodEnd: true,
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText(/Access ends/)).resolves.toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Open workspace" })
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /Subscribe to/ })
    ).not.toBeInTheDocument()
  },
}
export const Member: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/Only organization owners and admins/)
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /Subscribe to/ })
    ).not.toBeInTheDocument()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", async () => {
          await delay("infinite")
          return HttpResponse.json(unpaid)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading subscription")
  },
}
export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/billing/status",
          () =>
            HttpResponse.json(
              { error: { message: "Billing is temporarily unavailable." } },
              { status: 503 }
            ),
          { once: true }
        ),
        status(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Billing is temporarily unavailable"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByRole("heading", { name: "Choose a Cloud plan" })
    ).resolves.toBeVisible()
  },
}

export const UsageWarning: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () => HttpResponse.json(activeUsage)),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/85% of your monthly allowance/)
    ).resolves.toBeVisible()
    await expect(canvas.getByText(/20,000 traces · 65,000 spans/)).toBeVisible()
  },
}
export const UsageLimit: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () =>
          HttpResponse.json({
            ...activeUsage,
            usage: {
              ...activeUsage.usage,
              spans: 80000,
              used: 100000,
              remaining: 0,
              percent: 100,
            },
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/New records are paused/)
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Open workspace" })
    ).toBeVisible()
  },
}
export const PaymentGrace: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () =>
          HttpResponse.json({
            ...activeUsage,
            status: "past_due",
            graceUntil: "2026-09-29T00:00:00Z",
            nextPaymentAttempt: "2026-09-24T00:00:00Z",
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/Your renewal payment failed/)
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Update payment method" })
    ).toBeEnabled()
    await expect(
      canvas.getByRole("link", { name: "Open workspace" })
    ).toBeVisible()
  },
}
export const PaymentGraceExpired: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/billing/status", () =>
          HttpResponse.json({
            ...activeUsage,
            status: "past_due",
            active: false,
            graceUntil: "2026-09-20T00:00:00Z",
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/payment grace period has ended/)
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Update payment method" })
    ).toBeEnabled()
    await expect(
      canvas.queryByRole("link", { name: "Open workspace" })
    ).not.toBeInTheDocument()
  },
}

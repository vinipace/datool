import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, mocked, userEvent, waitFor, within } from "storybook/test"
import { navigateWorkspace } from "@/lib/workspace-selection"
import { OnboardingAccount } from "@/components/auth/onboarding-account"
import { MarketingShell } from "@/components/cms/marketing-shell"
import { PricingCheckout, PricingPlanAction } from "./pricing-checkout"

let plans: unknown[] = []
const checkout = http.post("/api/billing/checkout", async ({ request }) => {
  const body = await request.json()
  plans.push(body)
  return HttpResponse.json({ url: "https://checkout.stripe.com/test-plan" })
})

const meta = {
  title: "Workspace/PricingCheckout",
  component: PricingCheckout,
  args: {
    onboarding: {
      organizationId: "new-org",
      canManage: true,
      pricesAvailable: true,
    },
    children: (
      <div className="flex flex-wrap gap-4 py-12">
        <PricingPlanAction plan="core" billingEnabled />
        <PricingPlanAction plan="pro" billingEnabled />
      </div>
    ),
  },
  parameters: { layout: "fullscreen", msw: { handlers: [checkout] } },
  decorators: [
    (Story) => (
      <MarketingShell
        onboardingAccount={<OnboardingAccount email="owner@example.test" />}
      >
        <Story />
      </MarketingShell>
    ),
  ],
  beforeEach: () => {
    plans = []
    mocked(navigateWorkspace).mockClear()
  },
} satisfies Meta<typeof PricingCheckout>
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByRole("link")).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Sign out" })).toBeVisible()
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument()
    await expect(plans).toHaveLength(0)
  },
}

export const ChoosePro: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Get Pro" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-plan"
      )
    )
    await expect(plans).toEqual([{ plan: "pro" }])
  },
}

export const ChooseCore: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Get Core" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-plan"
      )
    )
    await expect(plans).toEqual([{ plan: "core" }])
  },
}

export const CheckoutRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post(
          "/api/billing/checkout",
          () =>
            HttpResponse.json(
              { error: { message: "Unable to open payment." } },
              { status: 503 }
            ),
          { once: true }
        ),
        checkout,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Get Pro" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to open payment"
    )
    await expect(canvas.getByRole("button", { name: "Get Core" })).toBeEnabled()
    await userEvent.click(canvas.getByRole("button", { name: "Get Pro" }))
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-plan"
      )
    )
    await expect(plans).toEqual([{ plan: "pro" }])
  },
}

export const OpeningPayment: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/billing/checkout", async () => {
          await delay("infinite")
          return HttpResponse.json({})
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Get Pro" }))
    await expect(canvas.getByRole("button", { name: "Get Pro" })).toBeDisabled()
    await expect(
      canvas.getByRole("button", { name: "Get Core" })
    ).toBeDisabled()
  },
}

export const PricesUnavailable: Story = {
  args: {
    onboarding: {
      organizationId: "new-org",
      canManage: true,
      pricesAvailable: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Get Core" })
    ).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Get Pro" })).toBeDisabled()
  },
}

export const Member: Story = {
  args: {
    onboarding: {
      organizationId: "new-org",
      canManage: false,
      pricesAvailable: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/Ask an organization owner/)).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Get Core" })
    ).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Get Pro" })).toBeDisabled()
  },
}

export const PublicPricing: Story = {
  args: { onboarding: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("link", { name: "Get Pro" })).toHaveAttribute(
      "href",
      "/billing?plan=pro"
    )
    await expect(
      canvas.getByRole("link", { name: "Get Core" })
    ).toHaveAttribute("href", "/billing?plan=core")
    await expect(plans).toHaveLength(0)
  },
}

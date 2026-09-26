import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, mocked, userEvent, waitFor, within } from "storybook/test"
import { navigateWorkspace } from "@/lib/workspace-selection"
import { BillingOnboarding } from "./billing-onboarding"

let creations = 0
let checkouts = 0
const create = http.post(
  "/api/auth/organization/create",
  async ({ request }) => {
    const body = (await request.json()) as { name: string; slug: string }
    creations++
    return HttpResponse.json({ ...body, id: "onboarding-org" })
  }
)
const select = http.post("/api/auth/organization/set-active", () =>
  HttpResponse.json({ id: "onboarding-org" })
)
const checkout = http.post("/api/billing/checkout", async ({ request }) => {
  checkouts++
  expect(await request.json()).toEqual({ plan: "pro" })
  return HttpResponse.json({
    url: "https://checkout.stripe.com/test-onboarding",
  })
})
const meta = {
  title: "Workspace/BillingOnboarding",
  component: BillingOnboarding,
  args: {
    organizations: [],
    plan: "pro",
    email: "owner@example.test",
    prices: {
      core: { amount: 2900, currency: "usd", trialDays: 0 },
      pro: { amount: 19900, currency: "usd", trialDays: 0 },
    },
  },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: [create, select, checkout] },
  },
  beforeEach: () => {
    creations = 0
    checkouts = 0
    mocked(navigateWorkspace).mockClear()
  },
} satisfies Meta<typeof BillingOnboarding>
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {}

export const SelfHostedOrganization: Story = {
  args: { billingEnabled: false, plan: null, prices: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Local team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create organization" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith("/projects")
    )
    await expect(creations).toBe(1)
    await expect(checkouts).toBe(0)
  },
}

export const DirectSignup: Story = {
  args: { plan: null, prices: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("heading", { name: "Create your organization" })
    ).toBeVisible()
    await expect(
      canvas.queryByText(/Plan prices are unavailable/)
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Sign out" })).toBeVisible()
    await userEvent.type(canvas.getByLabelText("Organization name"), "New team")
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & choose a plan" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith("/pricing")
    )
    await expect(creations).toBe(1)
    await expect(checkouts).toBe(0)
  },
}

export const DirectSignupSelectionRetry: Story = {
  args: { plan: null, prices: null },
  parameters: {
    msw: {
      handlers: [
        create,
        http.post(
          "/api/auth/organization/set-active",
          () =>
            HttpResponse.json(
              { message: "Unable to select organization." },
              { status: 503 }
            ),
          { once: true }
        ),
        select,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Organization name"), "New team")
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & choose a plan" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to select"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Choose a plan" }))
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith("/pricing")
    )
    await expect(creations).toBe(1)
    await expect(checkouts).toBe(0)
  },
}

export const SignOut: Story = {
  args: { plan: null, prices: null },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-out", () =>
          HttpResponse.json({ success: true })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Sign out" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith("/sign-in")
    )
  },
}

export const NewOrganization: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("heading", { name: "Datool Pro" })
    ).toBeVisible()
    await expect(canvas.getByLabelText("Organization name")).toHaveFocus()
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Test team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-onboarding"
      )
    )
    await expect(creations).toBe(1)
  },
}

export const CheckoutRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        create,
        select,
        http.post(
          "/api/billing/checkout",
          () =>
            HttpResponse.json(
              {
                error: {
                  message: "Payment is temporarily unavailable. Try again.",
                },
              },
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
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Test team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Payment is temporarily unavailable"
    )
    await expect(canvas.getByText(/Test team is ready/)).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Continue to payment" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-onboarding"
      )
    )
    await expect(creations).toBe(1)
  },
}

export const CreationFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/organization/create", () =>
          HttpResponse.json(
            { message: "Unable to create your organization." },
            { status: 500 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Test team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to create"
    )
    await expect(canvas.getByLabelText("Organization name")).toHaveValue(
      "Test team"
    )
    await expect(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    ).toBeEnabled()
  },
}

export const ExistingOrganization: Story = {
  args: { organizations: [{ id: "existing", name: "Existing team" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Existing team" }))
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "/billing?plan=pro"
      )
    )
    await expect(creations).toBe(0)
  },
}

export const PricesUnavailable: Story = {
  args: { prices: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Test team"
    )
    await expect(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    ).toBeDisabled()
    await expect(
      canvas.getByRole("button", { name: "Try again" })
    ).toBeVisible()
  },
}

export const OpeningPayment: Story = {
  parameters: {
    msw: {
      handlers: [
        create,
        select,
        http.post("/api/billing/checkout", async () => {
          await delay("infinite")
          return HttpResponse.json({})
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Test team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    )
    await expect(
      canvas.findByRole("button", { name: "Continue to payment" })
    ).resolves.toBeDisabled()
  },
}

export const CorePlan: Story = {
  args: { plan: "core" },
  parameters: {
    msw: {
      handlers: [
        create,
        select,
        http.post("/api/billing/checkout", async ({ request }) => {
          expect(await request.json()).toEqual({ plan: "core" })
          return HttpResponse.json({
            url: "https://checkout.stripe.com/test-core",
          })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("region", { name: "Core plan benefits" })
    ).toBeVisible()
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument()
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Core team"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create & continue to payment" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "https://checkout.stripe.com/test-core"
      )
    )
    await expect(creations).toBe(1)
  },
}

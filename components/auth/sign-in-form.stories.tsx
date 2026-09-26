import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { storybookAuthHandlers } from "../../.storybook/scenarios/auth-workspace/handlers"
import { SignInForm } from "./sign-in-form"

const meta = {
  title: "Auth/SignInForm",
  component: SignInForm,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        http.get("/api/auth/config", () =>
          HttpResponse.json({ google: true, emailLink: true })
        ),
      ],
    },
    nextjs: { navigation: { pathname: "/sign-in", query: {} } },
  },
} satisfies Meta<typeof SignInForm>

export default meta
type Story = StoryObj<typeof meta>

export const ProOnboarding: Story = {
  args: {
    publicSignup: true,
    prices: {
      core: { amount: 2900, currency: "usd", trialDays: 0 },
      pro: { amount: 19900, currency: "usd", trialDays: 0 },
    },
  },
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-in",
        query: { callbackUrl: "/billing?plan=pro" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Get started with Pro" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("region", { name: "Pro plan benefits" })
    ).toBeVisible()
    await expect(canvas.getByText("$199.00", { exact: false })).toBeVisible()
    await expect(canvas.getByText("Billed monthly in USD.")).toBeVisible()
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument()
    await expect(canvas.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/sign-up?callbackUrl=%2Fbilling%3Fplan%3Dpro"
    )
  },
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Sign in to Datool" })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByRole("button", { name: "Continue with Google" })
    ).resolves.toBeEnabled()
    await expect(
      canvas.getByRole("textbox", { name: "Email address" })
    ).toBeVisible()
  },
}

export const SignUp: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-up",
        query: { callbackUrl: "/p/support/traces" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Already have an account?")
    ).resolves.toBeVisible()
    await expect(canvas.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fp%2Fsupport%2Ftraces"
    )
  },
}

export const EmailLinkSent: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-up",
        query: { callbackUrl: "/p/support/traces" },
      },
    },
    msw: {
      handlers: [
        http.get("/api/auth/config", () =>
          HttpResponse.json({ google: true, emailLink: true })
        ),
        http.post("/api/auth/sign-in/magic-link", async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          if (
            body.email !== "alice@example.com" ||
            body.callbackURL !== "/p/support/traces" ||
            body.errorCallbackURL !==
              "/sign-up?callbackUrl=%2Fp%2Fsupport%2Ftraces&method=email"
          )
            return HttpResponse.json(
              { message: "Unexpected sign-in request" },
              { status: 400 }
            )
          await delay(200)
          return HttpResponse.json({ status: true })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Email address" }),
      "Alice@Example.com"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Send sign-in link" })
    )
    await expect(
      canvas.getByRole("button", { name: "Sending link…" })
    ).toBeDisabled()
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Check your inbox."
    )
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "alice@example.com"
    )
  },
}

export const EmailDeliveryFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/auth/config", () =>
          HttpResponse.json({ google: true, emailLink: true })
        ),
        http.post("/api/auth/sign-in/magic-link", () =>
          HttpResponse.json(
            { code: "EMAIL_DELIVERY_FAILED", message: "Delivery failed" },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Email address" }),
      "alice@example.com"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Send sign-in link" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Please try again shortly."
    )
    await expect(
      canvas.getByRole("button", { name: "Send sign-in link" })
    ).toBeEnabled()
    await expect(
      canvas.getByRole("button", { name: "Continue with Google" })
    ).toBeEnabled()
  },
}

export const ExpiredEmailLink: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-in",
        query: { method: "email", error: "INVALID_TOKEN" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("expired or was already used")
  },
}

export const GoogleOnly: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/auth/config", () =>
          HttpResponse.json({ google: true, emailLink: false })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("button", { name: "Continue with Google" })
    ).resolves.toBeEnabled()
    await expect(
      canvas.queryByRole("textbox", { name: "Email address" })
    ).not.toBeInTheDocument()
  },
}

export const RequestedProject: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-in",
        query: { callbackUrl: "/p/support-copilot/traces" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("button", {
        name: "Continue with Google",
      })
    ).resolves.toBeEnabled()
  },
}

export const OAuthError: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-in",
        query: { error: "account_not_linked" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Google is not linked")
  },
}

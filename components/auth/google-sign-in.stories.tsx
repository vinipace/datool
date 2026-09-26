import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  betterAuthError,
  storybookAuthHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { GoogleSignIn } from "./google-sign-in"

const configPath = "/api/auth/config"

const meta = {
  title: "Auth/GoogleSignIn",
  component: GoogleSignIn,
  args: { callbackURL: "/projects" },
  render: (args) => (
    <div className="w-80">
      <GoogleSignIn {...args} />
    </div>
  ),
} satisfies Meta<typeof GoogleSignIn>

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {
  parameters: {
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        http.get(configPath, () => HttpResponse.json({ google: true })),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = await canvas.findByRole("button", {
      name: "Continue with Google",
    })
    await userEvent.click(button)
    await expect(
      canvas.getByRole("button", { name: "Connecting to Google…" })
    ).toHaveAttribute("aria-busy", "true")
  },
}

export const Unavailable: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(configPath, () => HttpResponse.json({ google: false })),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Google sign-in is currently unavailable")
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(configPath, async () => {
          await delay("infinite")
          return HttpResponse.json({ google: true })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading sign-in…")
  },
}

export const ProviderFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(configPath, () => HttpResponse.json({ google: true })),
        http.post("/api/auth/sign-in/social", () =>
          betterAuthError(
            "Google rejected this sign-in request.",
            403,
            "SOCIAL_SIGN_IN_REJECTED"
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Continue with Google" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Google rejected this sign-in request."
    )
  },
}

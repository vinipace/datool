import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { PasswordSignIn } from "./password-sign-in"

const meta = {
  title: "Auth/PasswordSignIn",
  component: PasswordSignIn,
  args: { callbackURL: "#workspace" },
} satisfies Meta<typeof PasswordSignIn>
export default meta
type Story = StoryObj<typeof meta>

// The provider owns the OAuth continuation. A second workspace navigation loses it.
export const OAuthReturn: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-in/email", () =>
          HttpResponse.json({ redirect: true, url: "#oauth-continuation" })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Sign in with a password" })
    )
    await userEvent.type(
      canvas.getByLabelText("Email address"),
      "local@example.test"
    )
    await userEvent.type(canvas.getByLabelText("Password"), "test-password")
    await userEvent.click(
      canvas.getByRole("button", { name: "Sign in" })
    )
    await waitFor(() =>
      expect(window.location.hash).toBe("#oauth-continuation")
    )
  },
}

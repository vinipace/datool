import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { InvitationPage } from "./invitation-page"

const meta = {
  title: "Workspace/InvitationPage",
  component: InvitationPage,
  args: {
    id: "invitation",
    invitation: {
      kind: "ready",
      email: "teammate@example.test",
      organizationName: "Datool demo",
      role: "member",
    },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InvitationPage>
export default meta
type Story = StoryObj<typeof meta>
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Accept invitation" })
    ).toBeEnabled()
  },
}
export const SignIn: Story = {
  args: { invitation: { kind: "sign-in" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/matching the email address/)
    ).toBeVisible()
  },
}
export const WrongAccount: Story = {
  args: {
    invitation: { kind: "wrong-account", email: "another@example.test" },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Use a different account",
      })
    ).toBeVisible()
  },
}
export const Expired: Story = {
  args: { invitation: { kind: "unavailable" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        /expired, was canceled, or has already been used/
      )
    ).toBeVisible()
  },
}
export const AcceptanceError: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/organization/accept-invitation", () =>
          HttpResponse.json(
            { message: "This invitation has expired." },
            { status: 400 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Accept invitation" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "expired"
    )
    await expect(
      canvas.getByRole("button", { name: "Accept invitation" })
    ).toBeEnabled()
  },
}
export const Decline: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/organization/reject-invitation", () =>
          HttpResponse.json({ id: "invitation", status: "rejected" })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Decline" }))
    await expect(
      canvas.findByRole("heading", { name: "Invitation declined" })
    ).resolves.toBeVisible()
  },
}

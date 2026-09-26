import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { MembersPage } from "./members-page"
import type { OrganizationMembers } from "@/src/lib/members"

const initial: OrganizationMembers = {
  canManage: true,
  currentUserId: "owner",
  role: "owner",
  emailConfigured: true,
  members: [
    {
      id: "member-owner",
      userId: "owner",
      name: "Ana Martins",
      email: "ana@example.test",
      role: "owner",
      createdAt: "2026-09-22T00:00:00Z",
    },
    {
      id: "member-teammate",
      userId: "teammate",
      name: "Bruno Costa",
      email: "bruno@example.test",
      role: "member",
      createdAt: "2026-09-22T00:00:00Z",
    },
  ],
  invitations: [
    {
      id: "pending",
      email: "carla@example.test",
      role: "member",
      createdAt: "2026-09-22T00:00:00Z",
      expiresAt: "2030-09-24T00:00:00Z",
      expired: false,
      emailStatus: "sent",
    },
  ],
}
const endpoint = "/api/organizations/team/members"
const status = (value = initial) =>
  http.get(endpoint, () => HttpResponse.json(value))
const meta = {
  title: "Workspace/MembersPage",
  component: MembersPage,
  args: {
    organization: { id: "team", name: "Datool demo", slug: "datool-demo" },
  },
  parameters: { layout: "fullscreen", msw: { handlers: [status()] } },
} satisfies Meta<typeof MembersPage>
export default meta
type Story = StoryObj<typeof meta>

export const Members: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Ana Martins (you)")).resolves.toBeVisible()
    await expect(canvas.getByText("bruno@example.test")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Invite member" })
    ).toBeVisible()
    await expect(
      canvas.queryByRole("textbox", { name: "Email address" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("carla@example.test")
    ).not.toBeInTheDocument()
  },
}
export const InviteTeammate: Story = {
  parameters: {
    msw: {
      handlers: [
        status({ ...initial, invitations: [] }),
        http.post(
          "/api/auth/organization/invite-member",
          async ({ request }) => {
            const body = (await request.json()) as {
              email: string
              role: string
              organizationId: string
            }
            if (
              body.email !== "new@example.test" ||
              body.role !== "admin" ||
              body.organizationId !== "team"
            )
              return HttpResponse.json(
                { message: "Invalid invitation" },
                { status: 400 }
              )
            return HttpResponse.json({ id: "new-invitation" })
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Invite member" })
    )
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "Invite member",
      })
    )
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Email address" }),
      "new@example.test"
    )
    await userEvent.click(dialog.getByRole("combobox", { name: "Role" }))
    await userEvent.click(await dialog.findByRole("option", { name: "Admin" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Send invitation" })
    )
    await expect(
      canvas.findByText("Invitation email sent.")
    ).resolves.toBeVisible()
    await expect(
      within(document.body).queryByRole("dialog")
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Invite member" })
    ).toHaveFocus()
  },
}
export const FailedEmail: Story = {
  parameters: {
    msw: {
      handlers: [
        status({
          ...initial,
          invitations: [{ ...initial.invitations[0], emailStatus: "failed" }],
        }),
        http.post("/api/auth/organization/invite-member", () =>
          HttpResponse.json(
            {
              message:
                "The invitation was saved, but email delivery could not be confirmed. Use Resend invitation to try again.",
            },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Pending invitations (1)" })
    )
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "Pending invitations (1)",
      })
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Resend invitation" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "email delivery could not be confirmed"
    )
    await expect(
      dialog.getByRole("button", { name: "Resend invitation" })
    ).toBeEnabled()
  },
}
export const ReadOnlyMember: Story = {
  parameters: {
    msw: {
      handlers: [
        status({
          ...initial,
          canManage: false,
          currentUserId: "teammate",
          role: "member",
          invitations: [],
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(/Only owners and admins/)
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Invite member" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /^Actions for/ })
    ).not.toBeInTheDocument()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json(initial)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading members")
  },
}
export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          endpoint,
          () =>
            HttpResponse.json(
              { error: { message: "Unable to load members." } },
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
      "Unable to load members"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
    await expect(canvas.findByText("Ana Martins (you)")).resolves.toBeVisible()
  },
}
export const SenderNotConfigured: Story = {
  parameters: {
    msw: {
      handlers: [
        status({ ...initial, emailConfigured: false, invitations: [] }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Invite member" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(
      dialog.getByText(/Email invitations are not configured/)
    ).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: "Send invitation" })
    ).toBeDisabled()
  },
}
export const RemoveMember: Story = {
  parameters: {
    msw: {
      handlers: [
        status(),
        http.post("/api/auth/organization/remove-member", () =>
          HttpResponse.json({ member: initial.members[1] })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const actions = await canvas.findByRole("button", {
      name: "Actions for Bruno Costa",
    })
    await userEvent.click(actions)
    await userEvent.click(
      await within(document.body).findByRole("menuitem", { name: "Remove" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(dialog.getByText(/lose access to every project/)).toBeVisible()
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await expect(actions).toHaveFocus()
    await userEvent.click(actions)
    await userEvent.click(
      await within(document.body).findByRole("menuitem", { name: "Remove" })
    )
    const confirmation = within(
      await within(document.body).findByRole("dialog")
    )
    await userEvent.click(confirmation.getByRole("button", { name: "Confirm" }))
    await expect(canvas.findByText("Member removed.")).resolves.toBeVisible()
  },
}

export const MemberActions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const actions = await canvas.findByRole("button", {
      name: "Actions for Bruno Costa",
    })
    await expect(
      canvas.queryByRole("button", { name: "Actions for Ana Martins" })
    ).not.toBeInTheDocument()
    actions.focus()
    await userEvent.keyboard("{Enter}")
    const menu = within(await within(document.body).findByRole("menu"))
    await expect(
      menu.getByRole("menuitem", { name: "Make admin" })
    ).toHaveFocus()
    await expect(menu.getByRole("menuitem", { name: "Remove" })).toBeVisible()
    await userEvent.keyboard("{Enter}")
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "Change role to admin?",
      })
    )
    await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus()
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await expect(actions).toHaveFocus()
    await expect(
      within(document.body).queryByRole("menu")
    ).not.toBeInTheDocument()
  },
}

export const SearchMembers: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Ana Martins (you)")
    const search = canvas.getByRole("textbox", { name: "Search members" })
    await userEvent.type(search, "BRUNO@EXAMPLE.TEST")
    await expect(canvas.getByText("Bruno Costa")).toBeVisible()
    await expect(
      canvas.queryByText("Ana Martins (you)")
    ).not.toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, "owner")
    await expect(canvas.getByText("Ana Martins (you)")).toBeVisible()
    await expect(canvas.queryByText("Bruno Costa")).not.toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, "nobody")
    await expect(canvas.getByText(/No matching members/)).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await expect(canvas.getByText("Bruno Costa")).toBeVisible()
  },
}

export const DialogFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Invite member" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(
      dialog.getByRole("textbox", { name: "Email address" })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.getByRole("button", { name: "Invite member" })
    ).toHaveFocus()
    await userEvent.click(
      canvas.getByRole("button", { name: "Pending invitations (1)" })
    )
    const pending = within(await within(document.body).findByRole("dialog"))
    await expect(pending.getByText("carla@example.test")).toBeVisible()
    await userEvent.click(pending.getByRole("button", { name: "Done" }))
    await expect(
      canvas.getByRole("button", { name: "Pending invitations (1)" })
    ).toHaveFocus()
  },
}

export const EmptyInvitations: Story = {
  parameters: { msw: { handlers: [status({ ...initial, invitations: [] })] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Pending invitations (0)" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(dialog.getByText("No pending invitations.")).toBeVisible()
  },
}

export const CancelInvitation: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () => HttpResponse.json(initial), { once: true }),
        status({ ...initial, invitations: [] }),
        http.post(
          "/api/auth/organization/cancel-invitation",
          async ({ request }) => {
            const body = (await request.json()) as { invitationId: string }
            return body.invitationId === "pending"
              ? HttpResponse.json({ id: "pending" })
              : HttpResponse.json(
                  { message: "Wrong invitation" },
                  { status: 400 }
                )
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Pending invitations (1)" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await userEvent.click(
      dialog.getByRole("button", { name: "Cancel invitation" })
    )
    await expect(
      dialog.findByText("No pending invitations.")
    ).resolves.toBeVisible()
    await expect(dialog.getByRole("status")).toHaveTextContent(
      "Invitation canceled."
    )
    await userEvent.click(dialog.getByRole("button", { name: "Done" }))
    await expect(
      canvas.getByRole("button", { name: "Pending invitations (0)" })
    ).toBeVisible()
  },
}

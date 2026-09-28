import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, spyOn, userEvent, waitFor, within } from "storybook/test"
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

async function invitationActions(panel: ReturnType<typeof within>) {
  await userEvent.click(
    panel.getByRole("button", {
      name: "Invitation actions for carla@example.test",
    })
  )
  return within(await within(document.body).findByRole("menu"))
}

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
    const actions = await invitationActions(dialog)
    await userEvent.click(
      actions.getByRole("menuitem", { name: "Resend invitation" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "email delivery could not be confirmed"
    )
    await expect(
      dialog.getByRole("button", {
        name: "Invitation actions for carla@example.test",
      })
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
    await expect(
      pending.getByRole("button", {
        name: "Copy invitation link for carla@example.test",
      })
    ).toHaveFocus()
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    await expect(pending.getByRole("button", { name: "Close" })).toHaveFocus()
    await userEvent.keyboard("{Tab}")
    await expect(
      pending.getByRole("button", {
        name: "Copy invitation link for carla@example.test",
      })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
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
    const actions = await invitationActions(dialog)
    await userEvent.click(
      actions.getByRole("menuitem", { name: "Cancel invitation" })
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

export const PendingInvitations: Story = {
  parameters: {
    msw: {
      handlers: [
        status({
          ...initial,
          invitations: [
            initial.invitations[0],
            {
              ...initial.invitations[0],
              id: "failed",
              email: "alexandra.long-recipient@example.test",
              role: "admin",
              emailStatus: "failed",
            },
            {
              ...initial.invitations[0],
              id: "expired",
              email: "expired@example.test",
              expiresAt: "2020-09-24T00:00:00Z",
              expired: true,
            },
          ],
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Pending invitations (3)",
      })
    )
    const panel = within(await within(document.body).findByRole("dialog"))
    await expect(
      panel.getByRole("table", { name: "Pending invitations" })
    ).toBeVisible()
    await expect(
      panel.getByRole("button", {
        name: "Copy invitation link for expired@example.test",
      })
    ).toBeDisabled()
  },
}

export const CopyUnconfirmedInvitation: Story = {
  parameters: {
    msw: {
      handlers: [
        status({
          ...initial,
          emailConfigured: false,
          invitations: [{ ...initial.invitations[0], emailStatus: "failed" }],
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockResolvedValue()
    try {
      await userEvent.click(
        await within(canvasElement).findByRole("button", {
          name: "Pending invitations (1)",
        })
      )
      const panel = within(await within(document.body).findByRole("dialog"))
      await userEvent.click(
        panel.getByRole("button", {
          name: "Copy invitation link for carla@example.test",
        })
      )
      await expect(panel.findByRole("status")).resolves.toHaveTextContent(
        "Invitation link copied for carla@example.test."
      )
      await expect(writeClipboard).toHaveBeenCalledTimes(1)
      await expect(writeClipboard).toHaveBeenCalledWith(
        `${window.location.origin}/invite/pending`
      )
      const actions = await invitationActions(panel)
      await expect(
        actions.getByRole("menuitem", { name: "Resend invitation" })
      ).toHaveAttribute("aria-disabled", "true")
      await userEvent.keyboard("{Escape}")
    } finally {
      writeClipboard.mockRestore()
    }
  },
}

export const ClipboardFailure: Story = {
  play: async ({ canvasElement }) => {
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockRejectedValue(new Error("Clipboard denied"))
    try {
      await userEvent.click(
        await within(canvasElement).findByRole("button", {
          name: "Pending invitations (1)",
        })
      )
      const panel = within(await within(document.body).findByRole("dialog"))
      await userEvent.click(
        panel.getByRole("button", {
          name: "Copy invitation link for carla@example.test",
        })
      )
      await expect(panel.findByRole("alert")).resolves.toHaveTextContent(
        "Select and copy the invitation link below"
      )
      const link = panel.getByRole("textbox", {
        name: "Invitation link for carla@example.test",
      }) as HTMLInputElement
      await expect(link).toHaveValue(`${window.location.origin}/invite/pending`)
      await expect(link).toHaveFocus()
      await expect(link.selectionStart).toBe(0)
      await expect(link.selectionEnd).toBe(link.value.length)
    } finally {
      writeClipboard.mockRestore()
    }
  },
}

export const ResendExpiredInvitation: Story = {
  parameters: {
    msw: {
      handlers: [
        // A cached response can cross its expiry even with expired=false.
        http.get(
          endpoint,
          () =>
            HttpResponse.json({
              ...initial,
              invitations: [
                {
                  ...initial.invitations[0],
                  expiresAt: "2020-09-24T00:00:00Z",
                  expired: false,
                },
              ],
            }),
          { once: true }
        ),
        status({
          ...initial,
          invitations: [{ ...initial.invitations[0], id: "fresh-invitation" }],
        }),
        http.post(
          "/api/auth/organization/invite-member",
          async ({ request }) => {
            const body = (await request.json()) as {
              email: string
              organizationId: string
              resend: boolean
            }
            if (
              body.email !== "carla@example.test" ||
              body.organizationId !== "team" ||
              !body.resend
            ) {
              return HttpResponse.json(
                { message: "Invalid resend" },
                { status: 400 }
              )
            }
            return HttpResponse.json({ id: "fresh-invitation" })
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockResolvedValue()
    try {
      await userEvent.click(
        await within(canvasElement).findByRole("button", {
          name: "Pending invitations (1)",
        })
      )
      const panel = within(await within(document.body).findByRole("dialog"))
      await expect(
        panel.getByRole("button", {
          name: "Copy invitation link for carla@example.test",
        })
      ).toBeDisabled()
      const actions = await invitationActions(panel)
      await userEvent.click(
        actions.getByRole("menuitem", { name: "Resend invitation" })
      )
      await expect(panel.findByRole("status")).resolves.toHaveTextContent(
        "Invitation email resent."
      )
      await waitFor(() =>
        expect(
          panel.getByRole("button", {
            name: "Copy invitation link for carla@example.test",
          })
        ).toBeEnabled()
      )
      await userEvent.click(
        panel.getByRole("button", {
          name: "Copy invitation link for carla@example.test",
        })
      )
      await waitFor(() =>
        expect(writeClipboard).toHaveBeenCalledWith(
          `${window.location.origin}/invite/fresh-invitation`
        )
      )
    } finally {
      writeClipboard.mockRestore()
    }
  },
}

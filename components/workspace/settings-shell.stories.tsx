import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, mocked, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { SettingsShell } from "./settings-shell"
import { navigateWorkspace } from "@/lib/workspace-selection"

const organization = { id: "team", name: "Datool demo", slug: "datool-demo" }
const otherOrganization = {
  id: "other-team",
  name: "Other workspace",
  slug: "other-workspace",
}

const meta = {
  title: "Workspace/SettingsShell",
  component: SettingsShell,
  args: {
    title: "API keys",
    backHref: "/projects",
    children: (
      <p className="p-4 text-sm text-foreground-muted">
        Manage scoped credentials.
      </p>
    ),
  },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/organizations/:organizationId/projects", () =>
          HttpResponse.json({ projects: [], total: 0, page: 1, pageSize: 100 })
        ),
        http.get("/api/auth/organization/list", () =>
          HttpResponse.json([organization, otherOrganization])
        ),
        http.post("/api/auth/organization/set-active", async ({ request }) => {
          const body = (await request.json()) as { organizationId: string }
          return body.organizationId === otherOrganization.id
            ? HttpResponse.json(otherOrganization)
            : HttpResponse.json(
                { message: "Wrong organization" },
                { status: 400 }
              )
        }),
      ],
    },
  },
} satisfies Meta<typeof SettingsShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Manage scoped credentials.")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Back to workspace" })
    ).toHaveAttribute("href", "/projects")
  },
}

export const OrganizationSettings: Story = {
  args: {
    title: "Organization settings",
    organization,
    children: <p className="p-4">Organization members</p>,
  },
  parameters: { nextjs: { navigation: { pathname: "/members" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(canvas.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/billing"
    )
    await expect(canvas.getByRole("heading", { name: "Members" })).toBeVisible()
    for (const [name, href] of [
      ["AI providers", "/settings/ai-providers"],
      ["Sandbox providers", "/settings/sandbox-providers"],
      ["Storage providers", "/settings/storage-providers"],
    ])
      await expect(canvas.getByRole("link", { name })).toHaveAttribute(
        "href",
        href
      )

    await expect(
      canvas.queryByRole("button", { name: /^Switch project:/ })
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Switch organization: Datool demo" })
    )
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      body.findByRole("button", { name: `Projects in ${organization.name}` })
    ).resolves.toHaveAttribute("aria-current", "true")
    await userEvent.type(
      body.getByRole("textbox", { name: "Find organization" }),
      "no matches"
    )
    await expect(body.getByText("No matching organizations.")).toBeVisible()
    await userEvent.clear(
      body.getByRole("textbox", { name: "Find organization" })
    )
    await userEvent.click(
      body.getByRole("button", { name: "Create organization" })
    )
    await expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
      "/organizations/new"
    )
    // Navigation is mocked; reopen the current organization menu to switch.
    const trigger = canvas.getByRole("button", {
      name: "Switch organization: Datool demo",
    })
    await userEvent.click(trigger)
    mocked(navigateWorkspace).mockClear()
    await userEvent.click(
      await body.findByRole("button", {
        name: `Projects in ${otherOrganization.name}`,
      })
    )
    await userEvent.click(
      await body.findByRole("link", { name: "View organization" })
    )
    await waitFor(() =>
      expect(navigateWorkspace).toHaveBeenCalledWith("/members")
    )
  },
}

export const BillingNavigation: Story = {
  args: {
    title: "Organization settings",
    organization,
    children: <p className="p-4">Billing and usage</p>,
  },
  parameters: { nextjs: { navigation: { pathname: "/billing" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { name: "Billing" })).toBeVisible()
    await expect(canvas.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(canvas.getByRole("link", { name: "Members" })).toHaveAttribute(
      "href",
      "/members"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Switch organization: Datool demo" })
    )
    mocked(navigateWorkspace).mockClear()
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("button", {
        name: `Projects in ${otherOrganization.name}`,
      })
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("link", {
        name: "View organization",
      })
    )
    await waitFor(() =>
      expect(navigateWorkspace).toHaveBeenCalledWith("/billing")
    )
  },
}

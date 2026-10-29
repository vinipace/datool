import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  storybookOrganization,
  storybookProject,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  betterAuthError,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  envelope,
  traceDetail,
} from "../../.storybook/scenarios/traces/fixtures"
import { ProjectScopeProvider } from "./project-scope"
import { ApiHelpLink, DemoWorkflowAction, TracerAppShell } from "./app-shell"
import type { AccountMenuUser } from "@/components/workspace/account-menu"

const prefix = `/p/${storybookProject.slug}`

function AppShellExample({
  user = { name: "Ana Martins", email: "ana@example.com", image: null },
  buildEnabled = false,
}: {
  user?: AccountMenuUser
  buildEnabled?: boolean
}) {
  return (
    <ProjectScopeProvider
      organizationId={storybookOrganization.id}
      prefix={prefix}
      projectId={storybookProject.id}
    >
      <div className="h-[720px] w-full">
        <TracerAppShell
          organization={storybookOrganization}
          project={storybookProject}
          user={user}
          buildEnabled={buildEnabled}
        >
          <div className="space-y-4 p-4">
            <h2 className="text-lg font-semibold">Trace workspace</h2>
            <p className="text-sm text-foreground-muted">
              The shell supplies navigation, header portals, and the inspector
              dock around each tracer page.
            </p>
            <DemoWorkflowAction />
            <ApiHelpLink />
          </div>
        </TracerAppShell>
      </div>
    </ProjectScopeProvider>
  )
}

const meta = {
  title: "Tracer/TracerAppShell",
  component: TracerAppShell,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
        http.post("/api/demo", () =>
          HttpResponse.json(
            envelope({
              datasetId: "dataset-storybook",
              evaluatorId: "evaluator-storybook",
              evalRunId: "eval-run-storybook",
              sessionId: "session-storybook-001",
              traceIds: [traceDetail.id],
              viewId: "view-storybook",
            })
          )
        ),
      ],
    },
    nextjs: {
      navigation: { pathname: `${prefix}/traces`, query: {} },
    },
  },
  render: () => <AppShellExample />,
} satisfies Meta<typeof TracerAppShell>

export default meta
type Story = StoryObj<typeof AppShellExample>

export const WorkspaceShell: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = within(
      canvas.getByRole("banner", { name: "Page controls" })
    ).getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    expect(
      canvas.queryByRole("link", { name: "Conversations" })
    ).not.toBeInTheDocument()
    expect(canvas.queryByText("Build", { exact: true })).not.toBeInTheDocument()
    expect(canvas.getByRole("link", { name: "Traces" })).toHaveAttribute(
      "href",
      `${prefix}/traces`
    )
    await expect(
      canvas.getByRole("banner", { name: "Page controls" })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: /Load sample workflow/ })
    )
    await expect(
      canvas.findByText("Sample workflow loaded")
    ).resolves.toBeVisible()
  },
}

export const InboxSidebar: Story = {
  render: () => <AppShellExample buildEnabled />,
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/build/inbox`, query: {} } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    const toggle = header.getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(
      canvas.getByRole("button", { name: "New Ticket" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Search inbox" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "My Inbox" })
    ).toHaveAttribute("href", `${prefix}/build/inbox?view=mine`)
    await expect(canvas.getByRole("link", { name: "Mentions" })).toBeVisible()
    await expect(
      canvas.queryByRole("link", { name: "Home" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("link", { name: "Traces" })
    ).not.toBeInTheDocument()
  },
}

export const BuildEnabled: Story = {
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/build/agents` } },
  },
  render: () => <AppShellExample buildEnabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = within(
      canvas.getByRole("banner", { name: "Page controls" })
    ).getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(
      within(
        canvas.getByRole("navigation", { name: "Workspace area" })
      ).getByRole("link", { name: "Build" })
    ).toBeVisible()
    for (const [label, route] of [
      ["Agents", "agents"],
      ["Conversations", "conversations"],
      ["Inbox", "inbox"],
      ["Contacts", "contacts"],
    ]) {
      await expect(canvas.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        `${prefix}/build/${route}`
      )
    }
  },
}

export const ScorerDetailRoute: Story = {
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/scorers/scorer_123` } },
  },
  play: async ({ canvasElement }) => {
    const header = within(
      within(canvasElement).getByRole("banner", { name: "Page controls" })
    )
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Scorer details"
    )
    await expect(header.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      `${prefix}/scorers`
    )
  },
}

export const NewScorerRoute: Story = {
  parameters: { nextjs: { navigation: { pathname: `${prefix}/scorers/new` } } },
  play: async ({ canvasElement }) => {
    const header = within(
      within(canvasElement).getByRole("banner", { name: "Page controls" })
    )
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "New scorer"
    )
    await expect(header.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      `${prefix}/scorers`
    )
  },
}

export const BuildNavigation: Story = {
  render: () => <AppShellExample buildEnabled />,
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/build/agents`, query: {} } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    const toggle = header.getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(
      header.getByRole("button", { name: /Switch project/ })
    ).toBeVisible()
    await expect(
      within(
        canvas.getByRole("navigation", { name: "Workspace area" })
      ).getByRole("link", { name: "Build" })
    ).toHaveAttribute("aria-current", "page")
    await expect(
      within(
        canvas.getByRole("navigation", { name: "Workspace area" })
      ).getByRole("link", { name: "Observe" })
    ).toHaveAttribute("href", prefix)
    await expect(canvas.getByRole("link", { name: "Agents" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(
      canvas.queryByRole("link", { name: "Traces" })
    ).not.toBeInTheDocument()
  },
}

export const SettingsNavigation: Story = {
  parameters: { nextjs: { navigation: { pathname: `${prefix}/settings` } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    const toggle = header.getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(canvas.getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(
      canvas.getByRole("link", { name: "API keys" })
    ).toHaveAttribute("href", `${prefix}/settings/api-keys`)
    await expect(
      canvas.getByRole("link", { name: "MCP connections" })
    ).toHaveAttribute("href", `${prefix}/settings/mcp`)
    await expect(
      canvas.queryByRole("link", { name: "Traces" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Back to project" })
    ).toHaveAttribute("href", `${prefix}/traces`)
  },
}

export const SettingsChildNavigation: Story = {
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/settings/api-keys` } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    const toggle = header.getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(
      canvas.getByRole("link", { name: "General" })
    ).not.toHaveAttribute("aria-current")
    await expect(
      canvas.getByRole("link", { name: "API keys" })
    ).toHaveAttribute("aria-current", "page")
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "API keys"
    )
  },
}

async function openAccountMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const toggle = within(
    canvas.getByRole("banner", { name: "Page controls" })
  ).getByRole("button", { name: "Toggle sidebar" })
  if (toggle.getAttribute("aria-expanded") !== "true")
    await userEvent.click(toggle)
  const trigger = within(canvasElement.ownerDocument.body).getByRole("button", {
    name: /Account menu for/,
  })
  await userEvent.click(trigger)
  return {
    trigger,
    menu: within(canvasElement.ownerDocument.body).getByRole("menu"),
  }
}

export const AccountIdentity: Story = {
  play: async ({ canvasElement }) => {
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await expect(trigger).toHaveTextContent("Ana Martins")
    await expect(trigger).toHaveTextContent("ana@example.com")
    await expect(within(menu).getByText("Signed in as")).toBeVisible()
    await expect(within(menu).getByText("ana@example.com")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(trigger).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("menuitem", {
        name: "Profile",
      })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
  },
}

export const AccountSignOut: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-out", async () => {
          await delay(1000)
          return HttpResponse.json({ success: true })
        }),
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const router = getRouter()
    router.replace.mockClear()
    router.refresh.mockClear()
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Sign out" })
    )
    await expect(
      within(menu).getByRole("menuitem", { name: "Signing out…" })
    ).toHaveAttribute("aria-disabled", "true")
    await expect(trigger).toHaveAttribute("aria-busy", "true")
    await expect(router.replace).not.toHaveBeenCalled()
    await waitFor(
      () => expect(router.replace).toHaveBeenCalledWith("/sign-in"),
      { timeout: 3000 }
    )
    await expect(router.refresh).toHaveBeenCalledTimes(1)
    await userEvent.keyboard("{Escape}")
  },
}

let signOutAttempts = 0

export const AccountSignOutRetry: Story = {
  beforeEach: () => {
    signOutAttempts = 0
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-out", () => {
          signOutAttempts += 1
          return signOutAttempts === 1
            ? betterAuthError("Service unavailable", 503)
            : HttpResponse.json({ success: true })
        }),
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const router = getRouter()
    router.replace.mockClear()
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Sign out" })
    )
    await expect(within(menu).findByRole("alert")).resolves.toHaveTextContent(
      "Unable to sign out. Try again."
    )
    await expect(router.replace).not.toHaveBeenCalled()
    await expect(trigger).toHaveAttribute("aria-busy", "false")
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Sign out" })
    )
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"))
    await expect(signOutAttempts).toBe(2)
    await expect(within(menu).queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  },
}

export const AccountWithoutName: Story = {
  render: () => (
    <AppShellExample
      user={{
        name: "",
        email: "long.email.address.for.workspace.testing@example.com",
        image: null,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await expect(trigger).toHaveTextContent(
      "long.email.address.for.workspace.testing@example.com"
    )
    await expect(within(menu).getByText("Signed in as")).toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}

const profilePhoto =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNIm7kqbeYqBggFAC16BqWT5yU/AAAAAElFTkSuQmCC"
let profileAttempts = 0
export const EditProfile: Story = {
  beforeEach: () => {
    profileAttempts = 0
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/profile", async ({ request }) => {
          const body = (await request.json()) as {
            name: string
            photo?: string | null
          }
          await delay(250)
          if (++profileAttempts === 1)
            return HttpResponse.json(
              { error: { message: "Unable to save your profile. Try again." } },
              { status: 503 }
            )
          return HttpResponse.json({
            data: {
              name: body.name,
              email: "ana@example.com",
              image: body.photo === null ? null : profilePhoto,
            },
          })
        }),
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Profile" })
    )
    const dialog = within(await body.findByRole("dialog", { name: "Profile" }))
    const name = dialog.getByRole("textbox", { name: "Name" })
    await userEvent.clear(name)
    await expect(
      dialog.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.type(name, "Ana Support")
    const bytes = Uint8Array.from(atob(profilePhoto.split(",")[1]), (c) =>
      c.charCodeAt(0)
    )
    await userEvent.upload(
      dialog.getByLabelText("Photo", { exact: true }),
      new File([bytes], "avatar.png", { type: "image/png" })
    )
    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Remove photo" })).toBeVisible()
    )
    await waitFor(() => {
      const preview = body
        .getByRole("dialog", { name: "Profile" })
        .querySelector("img")
      expect(preview?.naturalWidth).toBe(256)
    })
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }))
    await expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Unable to save"
    )
    await expect(name).toHaveValue("Ana Support")
    await expect(
      dialog.getByRole("button", { name: "Remove photo" })
    ).toBeVisible()
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }))
    await expect(await dialog.findByText("Profile saved.")).toBeVisible()
    await expect(trigger).toHaveTextContent("Ana Support")
    await userEvent.click(dialog.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    await userEvent.click(body.getByRole("menuitem", { name: "Profile" }))
    const reopened = within(
      await body.findByRole("dialog", { name: "Profile" })
    )
    await expect(reopened.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Ana Support"
    )
    await userEvent.click(
      reopened.getByRole("button", { name: "Remove photo" })
    )
    await userEvent.click(
      reopened.getByRole("button", { name: "Save changes" })
    )
    await expect(await reopened.findByText("Profile saved.")).toBeVisible()
    await expect(
      reopened.queryByRole("button", { name: "Remove photo" })
    ).toBeNull()
    await userEvent.click(reopened.getByRole("button", { name: "Done" }))
  },
}

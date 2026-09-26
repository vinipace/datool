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
}: { user?: AccountMenuUser }) {
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
  const toggle = within(canvas.getByRole("banner", { name: "Page controls" }))
    .getByRole("button", { name: "Toggle sidebar" })
  if (toggle.getAttribute("aria-expanded") !== "true")
    await userEvent.click(toggle)
  const trigger = within(canvasElement.ownerDocument.body).getByRole("button", {
    name: /Account menu for/,
  })
  await userEvent.click(trigger)
  return { trigger, menu: within(canvasElement.ownerDocument.body).getByRole("menu") }
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
      within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: "Sign out" })
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
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }))
    await expect(within(menu).getByRole("menuitem", { name: "Signing out…" })).toHaveAttribute("aria-disabled", "true")
    await expect(trigger).toHaveAttribute("aria-busy", "true")
    await expect(router.replace).not.toHaveBeenCalled()
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"), { timeout: 3000 })
    await expect(router.refresh).toHaveBeenCalledTimes(1)
    await userEvent.keyboard("{Escape}")
  },
}

let signOutAttempts = 0

export const AccountSignOutRetry: Story = {
  beforeEach: () => { signOutAttempts = 0 },
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
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }))
    await expect(within(menu).findByRole("alert")).resolves.toHaveTextContent("Unable to sign out. Try again.")
    await expect(router.replace).not.toHaveBeenCalled()
    await expect(trigger).toHaveAttribute("aria-busy", "false")
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"))
    await expect(signOutAttempts).toBe(2)
    await expect(within(menu).queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  },
}

export const AccountWithoutName: Story = {
  render: () => <AppShellExample user={{ name: "", email: "long.email.address.for.workspace.testing@example.com", image: null }} />,
  play: async ({ canvasElement }) => {
    const { trigger, menu } = await openAccountMenu(canvasElement)
    await expect(trigger).toHaveTextContent("long.email.address.for.workspace.testing@example.com")
    await expect(within(menu).getByText("Signed in as")).toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}

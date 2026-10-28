import { useSyncExternalStore } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import {
  useSearchParams,
  ReadonlyURLSearchParams,
} from "@storybook/nextjs-vite/navigation.mock"
import { expect, userEvent, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { TracerAppShell } from "@/components/tracer/app-shell"
import { ProjectScopeProvider } from "@/components/tracer/project-scope"
import { storybookOrganization } from "@/.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "@/.storybook/scenarios/auth-workspace/handlers"
import { subscribeBrowserNavigation } from "@/components/navigation/navigation"
import { appIntegrationScenario } from "@/.storybook/scenarios/app-integrations"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import { BuildAgentEditor } from "./agent-editor"

const scenario = appIntegrationScenario()
const agent: ManagedAgent = {
  id: "calendar-agent",
  projectId: "storybook-project",
  slug: "calendar-agent",
  name: "Calendar assistant",
  description: "",
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({ model: "fixture-model" }),
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  archivedAt: null,
}
const meta = {
  title: "Build/AgentIntegrationsNavigation",
  component: BuildAgentEditor,
  args: { agent, initialTab: "integrations" },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/build/agents/calendar-agent" } },
    msw: {
      handlers: [
        http.get(
          "https://logos.composio.dev/api/:app",
          () => new HttpResponse(null, { status: 404 })
        ),
        ...scenario.handlers,
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  decorators: [
    (Story) => (
      <ProjectScopeProvider
        projectId="storybook-project"
        organizationId={storybookOrganization.id}
        prefix="/p/demo"
      >
        <div className="h-[900px]">
          <TracerAppShell
            organization={storybookOrganization}
            project={{ id: "storybook-project", name: "Demo", slug: "demo" }}
            user={{
              name: "Ana Martins",
              email: "ana@example.com",
              image: null,
            }}
          >
            <Story />
          </TracerAppShell>
        </div>
      </ProjectScopeProvider>
    ),
  ],
  beforeEach: () => {
    scenario.reset()
    const original = useSearchParams.getMockImplementation()
    const url = new URL(window.location.href)
    url.searchParams.delete("section")
    window.history.replaceState(null, "", url.toString())
    const originalPushState = window.history.pushState
    window.history.pushState = function (...args) {
      originalPushState.apply(this, args)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
    // Model Next's native-history subscription at the framework boundary so
    // this exercises the actual editor/sidebar navigation and retained draft.
    useSearchParams.mockImplementation(function useBrowserSearchParams() {
      const search = useSyncExternalStore(
        subscribeBrowserNavigation,
        () => window.location.search,
        () => ""
      )
      return new ReadonlyURLSearchParams(search)
    })
    return () => {
      window.history.pushState = originalPushState
      if (original) useSearchParams.mockImplementation(original)
    }
  },
} satisfies Meta<typeof BuildAgentEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Integrations: Story = {}
export const ManageFromAction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = within(
      canvas.getByRole("banner", { name: "Page controls" })
    ).getByRole("button", { name: "Toggle sidebar" })
    if (toggle.getAttribute("aria-expanded") !== "true")
      await userEvent.click(toggle)
    await expect(
      canvas.findByRole("link", { name: "Calendar assistant — back to agents" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("link", { name: "Home" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("link", { name: "Traces" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.findByRole("heading", { name: "Integrations" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("link", { name: "Actions" }))
    await userEvent.click(
      await canvas.findByRole("tab", { name: "Create Actions" })
    )
    await userEvent.click(
      await canvas.findByRole("button", { name: "Use connected app" })
    )
    const page = within(canvasElement.ownerDocument.body)
    const name = await page.findByLabelText("Name", { selector: "input" })
    await userEvent.clear(name)
    await userEvent.type(name, "My calendar action")
    await userEvent.click(
      page.getByRole("button", { name: "Manage integrations" })
    )
    await expect(
      canvas.findByRole("heading", { name: "Integrations" })
    ).resolves.toBeVisible()
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    await expect(
      canvas.findByRole("group", { name: "Google Calendar" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Manage" }))
    const integrationDialog = within(
      await page.findByRole("dialog", { name: "Google Calendar" })
    )
    await userEvent.click(
      integrationDialog.getByRole("button", { name: "Open Actions" })
    )
    await expect(
      page.queryByRole("dialog", { name: "Google Calendar" })
    ).not.toBeInTheDocument()
    await expect(
      page.findByLabelText("Name", { selector: "input" })
    ).resolves.toHaveValue("My calendar action")
    const dialog = within(await page.findByRole("dialog"))
    await expect(
      dialog.queryByRole("button", { name: /^Connect$/ })
    ).not.toBeInTheDocument()
    await expect(
      dialog.queryByRole("button", { name: "Disconnect" })
    ).not.toBeInTheDocument()
  },
}

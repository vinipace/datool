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
        http.get("*/api/custom-fields", () => HttpResponse.json({ data: [] })),
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
            buildEnabled
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
export const ManageTools: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const sidebar = canvas.getByRole("button", { name: "Toggle sidebar" })
    if (sidebar.getAttribute("aria-expanded") !== "true")
      await userEvent.click(sidebar)
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    const dialog = within(
      await page.findByRole("region", { name: "Google Calendar" })
    )
    const toggle = await dialog.findByRole("switch", {
      name: "Enable List calendar events",
    })
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(
      dialog.findByRole("switch", {
        name: "Enable Google Calendar: List calendar events",
      })
    ).resolves.toBeChecked()
    await userEvent.click(dialog.getByRole("button", { name: "Settings" }))
    const editor = within(await page.findByRole("dialog"))
    await expect(
      editor.getByLabelText("Name", { selector: "input" })
    ).toHaveValue("Google Calendar: List calendar events")
    await userEvent.click(editor.getByRole("button", { name: "Cancel" }))
    const reopened = within(
      await page.findByRole("region", { name: "Google Calendar" })
    )
    const enabled = await reopened.findByRole("switch", {
      name: "Enable Google Calendar: List calendar events",
    })
    await userEvent.click(enabled)
    await expect(enabled).not.toBeChecked()
    await userEvent.click(
      reopened.getByRole("button", { name: "Integrations" })
    )
    await userEvent.click(canvas.getByRole("link", { name: "Actions" }))
    await expect(
      canvas.queryByText("Google Calendar: List calendar events")
    ).not.toBeInTheDocument()
    await userEvent.click(await canvas.findByRole("tab", { name: "Templates" }))
    await expect(
      canvas.queryByRole("button", { name: "Use connected app" })
    ).not.toBeInTheDocument()
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  storybookOrganization,
  storybookProject,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  dashboardCatalogHandler,
  dashboardListHandler,
  dashboardDetailHandler,
  metricsBatchHandler,
} from "../../.storybook/scenarios/dashboards/handlers"
import { storybookDashboard } from "../../.storybook/scenarios/dashboards/fixtures"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { ProjectHome } from "@/src/lib/tracer/project-home"
import { TracerAppShell } from "./app-shell"
import { ProjectScopeProvider } from "./project-scope"
import { ProjectHomePage } from "./project-home-page"

const prefix = `/p/${storybookProject.slug}`
const agents: ManagedAgent[] = [
  { name: "Store assistant", avatarColor: "orange" },
  { name: "Customer support", avatarColor: "violet" },
  { name: "Product guide", avatarColor: "blue" },
].map(({ name, avatarColor }, index) => ({
  id: `home-agent-${index}`,
  projectId: storybookProject.id,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  name,
  description: null,
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({
    model: "fixture-model",
    appearance: { avatarColor },
  }),
  createdAt: "2026-10-28T12:00:00Z",
  updatedAt: "2026-10-29T08:00:00Z",
  archivedAt: null,
}))
const widgets = storybookDashboard.widgets.slice(0, 2).map((widget, index) => ({
  ...widget,
  layout: { x: index * 6, y: 0, w: 6, h: 4 },
}))
const home: ProjectHome = {
  revision: 1,
  widgets,
  pins: widgets.map((widget) => ({
    id: widget.id,
    widgetId: widget.id,
    dashboardId: storybookDashboard.id,
    dashboardName: storybookDashboard.name,
    title: widget.title,
    layout: widget.layout,
  })),
}

function scenario(
  mode: "populated" | "empty" | "loading" | "error" = "populated"
) {
  return [
    ...storybookAuthHandlers,
    ...workspaceProjectHandlers(),
    http.post("/api/build/build_list_agents", async () => {
      if (mode === "loading") await delay("infinite")
      if (mode === "error")
        return HttpResponse.json(
          { error: { message: "Agents are temporarily unavailable." } },
          { status: 503 }
        )
      return HttpResponse.json({ data: mode === "empty" ? [] : agents })
    }),
    http.get("/api/project-home", () => HttpResponse.json({ data: home })),
    dashboardListHandler(),
    dashboardDetailHandler(),
    dashboardCatalogHandler(),
    metricsBatchHandler(),
  ]
}

const meta = {
  title: "Tracer/ProjectHomePage",
  component: ProjectHomePage,
  args: { buildEnabled: true },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: prefix, query: {} } },
    msw: { handlers: scenario() },
  },
  render: (args) => (
    <ProjectScopeProvider
      organizationId={storybookOrganization.id}
      projectId={storybookProject.id}
      prefix={prefix}
    >
      <div className="h-dvh w-full">
        <TracerAppShell
          organization={storybookOrganization}
          project={storybookProject}
          user={{ name: "Ana Martins", email: "ana@example.com", image: null }}
          buildEnabled={args.buildEnabled}
        >
          <ProjectHomePage {...args} />
        </TracerAppShell>
      </div>
    </ProjectScopeProvider>
  ),
} satisfies Meta<typeof ProjectHomePage>
export default meta
type Story = StoryObj<typeof meta>

export const AgentsAndWidgets: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = await canvas.findByRole("link", {
      name: "Open Store assistant",
    })
    await expect(card).toHaveAttribute(
      "href",
      `${prefix}/build/agents/home-agent-0`
    )
    await expect(
      canvas.findByText(widgets[0].title, { exact: true })
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Actions for Store assistant" })
    )
    const menu = within(canvasElement.ownerDocument.body)
    await expect(
      await menu.findByRole("menuitem", { name: "Settings" })
    ).toHaveAttribute(
      "href",
      `${prefix}/build/agents/home-agent-0?section=settings`
    )
    await userEvent.keyboard("{Escape}")
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await userEvent.click(header.getByRole("button", { name: "Edit Home" }))
    await userEvent.click(
      await menu.findByRole("menuitem", { name: "Pin widgets" })
    )
    await expect(await menu.findByRole("dialog")).toHaveTextContent(
      "Pin widgets to Home"
    )
    await userEvent.keyboard("{Escape}")
    await card.focus()
  },
}

export const EmptyAgents: Story = {
  parameters: { msw: { handlers: scenario("empty") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Create your first agent")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "New agent" })
    ).toHaveAttribute("href", `${prefix}/build/agents/new`)
    await expect(
      canvas.findByText(widgets[0].title, { exact: true })
    ).resolves.toBeVisible()
  },
}

export const LoadingAgents: Story = {
  parameters: { msw: { handlers: scenario("loading") } },
}

export const AgentsUnavailable: Story = {
  parameters: { msw: { handlers: scenario("error") } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Agents are temporarily unavailable."
    )
    await expect(
      canvas.queryByText("Create your first agent")
    ).not.toBeInTheDocument()
    await expect(
      canvas.findByText(widgets[0].title, { exact: true })
    ).resolves.toBeVisible()
  },
}

export const ObserveOnly: Story = { args: { buildEnabled: false } }

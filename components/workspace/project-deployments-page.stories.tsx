import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { DeploymentBrowser } from "./project-deployments-page"
import { PageLayout } from "@/components/tracer/page-layout"
import {
  NavigationProvider,
  createMemoryNavigation,
  usePathname,
} from "@/components/navigation/navigation"
import type { DeploymentSummary } from "@/src/lib/deploy/contracts"

const production: DeploymentSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  environment: "production",
  hash: "a".repeat(64),
  title: "Publish company search tools",
  commit: "a".repeat(40),
  branch: "main",
  dirty: false,
  durationMs: 83000,
  createdAt: "2026-11-12T03:00:00Z",
  sandbox: "local",
  agents: ["assistant"],
  tools: ["search_projects", "brain_search"],
  sources: ["sources/company.md"],
  postgres: true,
  mcpPath: "/api/project-mcp?projectId=project-demo&environment=production",
  active: true,
}
const preview: DeploymentSummary = {
  ...production,
  id: "00000000-0000-4000-8000-000000000002",
  environment: "preview",
  title: "Test the returns policy",
  branch: "feature/returns-policy",
  active: false,
  mcpPath: "/api/project-mcp?projectId=project-demo&environment=preview",
}
const handler = http.get("/api/deployments", ({ request }) => {
  if (request.headers.get("x-project-id") !== "project-demo")
    return new HttpResponse(null, { status: 403 })
  const params = new URL(request.url).searchParams
  const deployment = params.get("id") === preview.id ? preview : production
  if (params.get("view") === "history")
    return HttpResponse.json({
      data: {
        items: params.get("filter")?.includes('"preview"')
          ? [preview]
          : [production, preview],
        activeId: production.id,
        nextCursor: null,
      },
    })
  if (params.get("view") === "detail")
    return HttpResponse.json({
      data: {
        deployment,
        active: deployment.active,
        tools: [
          {
            name: "search_projects",
            description: "Search project records by name.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        documents: [
          {
            path: "sources/company.md",
            title: "Returns policy",
            kind: "source",
            characters: 78,
          },
        ],
        collectors: [],
      },
    })
  if (
    params.get("view") === "source" &&
    params.get("path") === "sources/company.md"
  )
    return HttpResponse.json({
      data: {
        text: "Preview returns are accepted within thirty days. <script>unsafe()</script>",
      },
    })
  return new HttpResponse(null, { status: 404 })
})
function RoutedBrowser() {
  const pathname = usePathname()
  const deploymentId = pathname.split("/")[4]
  return (
    <PageLayout
      title={deploymentId ? deploymentId.slice(0, 8) : "Deployments"}
      className="h-[min(720px,100dvh)]"
    >
      <DeploymentBrowser
        key={pathname}
        projectId="project-demo"
        projectSlug="demo"
        origin="https://datool.example.test"
        deploymentId={deploymentId}
      />
    </PageLayout>
  )
}
function BrowserFrame() {
  const [adapter] = useState(() =>
    createMemoryNavigation("/p/demo/deployments")
  )
  return (
    <NavigationProvider adapter={adapter}>
      <RoutedBrowser />
    </NavigationProvider>
  )
}
const meta = {
  title: "Workspace/Deployments",
  component: DeploymentBrowser,
  args: {
    projectId: "project-demo",
    projectSlug: "demo",
    origin: "https://datool.example.test",
  },
  render: () => <BrowserFrame />,
  parameters: { layout: "fullscreen", msw: { handlers: [handler] } },
} satisfies Meta<typeof DeploymentBrowser>
export default meta
type Story = StoryObj<typeof meta>
// UI owner: route selection, filter application, lazy inspectors and focus after dismissal.
export const Published: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body)
    await userEvent.click(
      await canvas.findByRole("link", {
        name: "Open deployment Test the returns policy",
      })
    )
    const tool = await canvas.findByRole("row", {
      name: "Inspect search_projects",
    })
    tool.focus()
    await userEvent.keyboard("{Enter}")
    const dialog = await body.findByRole("dialog", { name: "search_projects" })
    await expect(within(dialog).getByText("Input schema")).toBeVisible()
    await expect(dialog).toHaveTextContent('"query"')
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(tool).toHaveFocus())
    await userEvent.click(canvas.getByRole("tab", { name: "Sources" }))
    const source = await canvas.findByRole("row", {
      name: "Read Returns policy",
    })
    await userEvent.click(source)
    const sourceDialog = await body.findByRole("dialog", {
      name: "Returns policy",
    })
    await expect(
      within(sourceDialog).findByText(/Preview returns are accepted/)
    ).resolves.toBeVisible()
    await expect(sourceDialog).toHaveTextContent("<script>unsafe()</script>")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(source).toHaveFocus())
    await userEvent.click(canvas.getByRole("button", { name: "Connect MCP" }))
    await expect(body.findByLabelText("MCP server URL")).resolves.toHaveValue(
      "https://datool.example.test/api/project-mcp?projectId=project-demo&environment=preview"
    )
    await userEvent.keyboard("{Escape}")
  },
}
export const FilterEnvironments: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", {
      name: "Open deployment Publish company search tools",
    })
    const input = canvas.getByRole("combobox", { name: "Filter expression" })
    await userEvent.click(input)
    await userEvent.keyboard('environment = "preview"{Enter}{Escape}')
    await waitFor(() =>
      expect(
        canvas.queryByRole("link", {
          name: "Open deployment Publish company search tools",
        })
      ).not.toBeInTheDocument()
    )
    await expect(
      canvas.findByRole("link", {
        name: "Open deployment Test the returns policy",
      })
    ).resolves.toBeVisible()
  },
}
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/deployments", () =>
          HttpResponse.json({
            data: { items: [], activeId: null, nextCursor: null },
          })
        ),
      ],
    },
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/deployments", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: null })
        }),
      ],
    },
  },
}
export const Retry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/deployments",
          () => new HttpResponse(null, { status: 503 }),
          { once: true }
        ),
        handler,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByRole("link", {
        name: "Open deployment Publish company search tools",
      })
    ).resolves.toBeVisible()
  },
}

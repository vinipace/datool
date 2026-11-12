import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { ProjectDeploymentCard } from "./project-deployment-card"

const deployment = {
  id: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-11-11T12:00:00Z",
  agents: ["foo"],
  tools: ["search_projects", "brain_search"],
  sources: ["sources/company.md"],
  mcpPath: "/api/project-mcp?projectId=project-demo",
}
const meta = {
  title: "Workspace/ProjectDeployment",
  component: ProjectDeploymentCard,
  args: {
    projectId: "project-demo",
    projectSlug: "demo",
    origin: "https://datool.example.test",
  },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/deployments", () => HttpResponse.json({ data: null })),
      ],
    },
  },
} satisfies Meta<typeof ProjectDeploymentCard>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {}
export const Published: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/deployments", () =>
          HttpResponse.json({ data: deployment })
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
// One UI owner: failed status reads can recover without changing the project scope.
export const Retry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/deployments",
          () => new HttpResponse(null, { status: 503 }),
          { once: true }
        ),
        http.get("/api/deployments", ({ request }) =>
          request.headers.get("x-project-id") === "project-demo"
            ? HttpResponse.json({ data: deployment })
            : new HttpResponse(null, { status: 403 })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByLabelText("Project MCP URL")
    ).resolves.toHaveValue(
      "https://datool.example.test/api/project-mcp?projectId=project-demo"
    )
  },
}

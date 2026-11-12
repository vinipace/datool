import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { IntegrationTools } from "./integration-tools"

const tools = Array.from({ length: 25 }, (_, index) => ({
  slug: `APP_TOOL_${index + 1}`,
  name: `Tool ${String(index + 1).padStart(2, "0")}`,
  description: `Description for tool ${index + 1}`,
  inputSchema: {},
}))
const records = tools.slice(0, 5).map((tool, index) => ({
  id: `action-${index}`,
  projectId: "project",
  agentId: "agent",
  slug: `action-${index}`,
  revision: 1,
  definition: {
    id: `action-${index}`,
    type: "integration",
    connectionId: "connection",
    toolSlug: tool.slug,
    name: `Example: ${tool.name}`,
    description: tool.description,
    enabled: true,
  },
}))
const meta = {
  title: "Build/IntegrationTools",
  component: IntegrationTools,
  args: {
    agentId: "agent",
    connectionId: "connection",
    connectionLabel: "Example",
  },
  parameters: {
    layout: "padded",
    msw: {
      handlers: [
        http.post("*/api/build/:operation", ({ params }) =>
          HttpResponse.json({
            data: params.operation === "build_list_actions" ? records : tools,
          })
        ),
      ],
    },
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-96 max-w-4xl overflow-y-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IntegrationTools>
export default meta
type Story = StoryObj<typeof meta>
export const Browsing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("of 25 enabled", { exact: false })
    ).resolves.toBeVisible()
    await expect(canvas.getByText("Tool 01")).toBeVisible()
    await expect(canvas.queryByText("Example: Tool 01")).not.toBeInTheDocument()
    await expect(canvas.queryByText("Tool 13")).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Next tools" })
    ).not.toBeInTheDocument()
    canvas.getByText("Tool 12").scrollIntoView({ block: "end" })
    await expect(canvas.findByText("Tool 13")).resolves.toBeVisible()
    await expect(canvas.getByText("Tool 01")).toBeInTheDocument()
    canvas.getByText("Tool 24").scrollIntoView({ block: "end" })
    await expect(canvas.findByText("Tool 25")).resolves.toBeVisible()
    await expect(canvas.getAllByRole("listitem")).toHaveLength(25)
    await expect(canvas.getByText("Showing 25 of 25 tools")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Enabled" }))
    await expect(canvas.getByText("Tool 01")).toBeVisible()
    await expect(canvas.queryByText("Tool 06")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Disabled" }))
    await expect(canvas.queryByText("Tool 01")).not.toBeInTheDocument()
    await waitFor(() => expect(canvas.getAllByRole("listitem")).toHaveLength(12))
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Search tools for Example" }),
      "Tool 25"
    )
    await expect(canvas.getByText("Tool 25")).toBeVisible()
    await expect(canvas.queryByText("Tool 24")).not.toBeInTheDocument()
    await userEvent.clear(
      canvas.getByRole("textbox", { name: "Search tools for Example" })
    )
    await expect(canvas.getAllByRole("listitem")).toHaveLength(12)
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Search tools for Example" }),
      "missing tool"
    )
    await expect(
      canvas.getByText("No tools match your search or filter.")
    ).toBeVisible()
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  apiError,
  mcpConnectionHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { storybookOrganization } from "../../.storybook/scenarios/auth-workspace/fixtures"
import { McpConnections } from "./mcp-connections"

const meta = {
  title: "Auth/McpConnections",
  component: McpConnections,
  args: {
    organizationId: storybookOrganization.id,
  },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: mcpConnectionHandlers() },
  },
} satisfies Meta<typeof McpConnections>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Cursor · Support copilot")
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getAllByRole("button", { name: "Revoke" })[0])
    await waitFor(() =>
      expect(
        canvas.queryByText("Cursor · Support copilot")
      ).not.toBeInTheDocument()
    )
    await expect(
      canvas.getByText("MCP client · Incident assistant")
    ).toBeVisible()
  },
}

export const Empty: Story = {
  parameters: { msw: { handlers: mcpConnectionHandlers({ connections: [] }) } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No authorized connections.")
    ).resolves.toBeVisible()
  },
}

export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/organizations/:organizationId/mcp-connections", () =>
          apiError("MCP connections could not be loaded.")
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("MCP connections could not be loaded.")
  },
}

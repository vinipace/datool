import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  apiError,
  mcpAuthorizationHandlers,
  storybookAuthHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { storybookProject } from "../../.storybook/scenarios/auth-workspace/fixtures"
import { McpAuthorization } from "./mcp-authorization"

const navigation = {
  pathname: "/mcp/authorize",
  query: {
    client_id: "cursor-storybook",
    datool_project: storybookProject.id,
    scope: "traces:read datasets:read offline_access",
  },
}

const meta = {
  title: "Auth/McpAuthorization",
  component: McpAuthorization,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation },
    msw: {
      handlers: [...storybookAuthHandlers, ...mcpAuthorizationHandlers()],
    },
  },
} satisfies Meta<typeof McpAuthorization>

export default meta
type Story = StoryObj<typeof meta>

export const ProjectSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Choose a project" })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByRole("option", { name: /Northstar Labs \/ Support copilot/ })
    ).resolves.toBeVisible()
    await expect(canvas.getByText("traces: read")).toBeVisible()
  },
}

export const Consent: Story = {
  args: { consent: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", {
        name: "Allow Storybook MCP client to access your project?",
      })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Deny" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Authorization was declined by the MCP client."
    )
  },
}

export const NoProjects: Story = {
  parameters: {
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        ...mcpAuthorizationHandlers({ projects: [] }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("link", { name: "your workspace" })
    ).resolves.toBeVisible()
  },
}

export const SignedOut: Story = {
  parameters: {
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        http.get("/api/mcp/authorization", () =>
          apiError("Sign in to connect MCP.", 401)
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Sign in to connect MCP.")
  },
}

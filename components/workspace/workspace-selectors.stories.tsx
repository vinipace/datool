import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, mocked, userEvent, within } from "storybook/test"
import { navigateWorkspace } from "@/lib/workspace-selection"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  apiError,
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  storybookOrganization,
  storybookOtherOrganization,
  storybookProject,
  storybookProjectPage,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import { WorkspaceSelectors } from "./workspace-selectors"

const meta = {
  title: "Workspace/WorkspaceSelectors",
  component: WorkspaceSelectors,
  args: { organization: storybookOrganization, project: storybookProject },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [...storybookAuthHandlers, ...workspaceProjectHandlers()],
    },
  },
  render: (args) => (
    <StorybookProjectFrame title="Workspace navigation" className="max-w-md">
      <div className="grid gap-3 p-3">
        <WorkspaceSelectors {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof WorkspaceSelectors>

export default meta
type Story = StoryObj<typeof meta>

export const CreateOrganization: Story = {
  beforeEach: () => {
    mocked(navigateWorkspace).mockClear()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await userEvent.click(
      body.getByRole("button", { name: "Create organization" })
    )
    await expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
      "/organizations/new"
    )
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument()
  },
}

export const SelectOrganizationAndProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await expect(
      documentBody.findByRole("link", { name: storybookOtherOrganization.name })
    ).resolves.toHaveAttribute("href", "/projects")
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch project: ${storybookProject.name}`,
      })
    )
    await expect(
      documentBody.findByRole("link", { name: "Incident assistant" })
    ).resolves.toBeVisible()
  },
}

export const ProjectLoading: Story = {
  parameters: {
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        http.get("/api/organizations/:organizationId/projects", async () => {
          await delay("infinite")
          return HttpResponse.json(storybookProjectPage)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch project: ${storybookProject.name}`,
      })
    )
    await expect(documentBody.findByRole("status")).resolves.toHaveTextContent(
      "Loading projects…"
    )
  },
}

export const ProjectErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        ...storybookAuthHandlers,
        http.get(
          "/api/organizations/:organizationId/projects",
          () => apiError("Projects are temporarily unavailable."),
          { once: true }
        ),
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch project: ${storybookProject.name}`,
      })
    )
    await expect(documentBody.findByRole("alert")).resolves.toHaveTextContent(
      "Projects are temporarily unavailable."
    )
    await userEvent.click(documentBody.getByRole("button", { name: "Retry" }))
    await expect(
      documentBody.findByRole("link", { name: "Incident assistant" })
    ).resolves.toBeVisible()
  },
}

export const OrganizationEmpty: Story = {
  args: { project: undefined },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/auth/organization/list", () => HttpResponse.json([])),
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await expect(
      documentBody.findByText("No organizations yet.")
    ).resolves.toBeVisible()
  },
}

export const OrganizationErrorAndRetry: Story = {
  args: { project: undefined, organizationDestination: "/members" },
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/auth/organization/list",
          () =>
            HttpResponse.json(
              { message: "Organizations are temporarily unavailable." },
              { status: 503 }
            ),
          { once: true }
        ),
        ...storybookAuthHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await expect(body.findByRole("alert")).resolves.toHaveTextContent(
      "Organizations are temporarily unavailable."
    )
    await userEvent.click(body.getByRole("button", { name: "Retry" }))
    await expect(
      body.findByRole("link", { name: storybookOtherOrganization.name })
    ).resolves.toHaveAttribute("href", "/members")
  },
}

export const OrganizationLoading: Story = {
  args: { project: undefined },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/auth/organization/list", async () => {
          await delay("infinite")
          return HttpResponse.json([])
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("status")
    ).resolves.toHaveTextContent("Loading organizations…")
  },
}

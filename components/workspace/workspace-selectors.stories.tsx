import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, mocked, userEvent, waitFor, within } from "storybook/test"
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

const otherOrganizationProject = {
  ...storybookProject,
  id: "signal-project",
  organizationId: storybookOtherOrganization.id,
  name: "Signal monitoring",
  slug: "signal-monitoring",
}

let activeOrganizationId = storybookOrganization.id
const navigations: { destination: string; organizationId: string }[] = []

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
  beforeEach: () => {
    activeOrganizationId = storybookOrganization.id
    navigations.length = 0
    mocked(navigateWorkspace).mockImplementation((destination) => {
      navigations.push({ destination, organizationId: activeOrganizationId })
    })
  },
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/organizations/:organizationId/projects",
          ({ params, request }) => {
            const search =
              new URL(request.url).searchParams.get("q")?.toLowerCase() ?? ""
            const projects = (
              params.organizationId === storybookOrganization.id
                ? storybookProjectPage.projects
                : [otherOrganizationProject]
            ).filter((project) => project.name.toLowerCase().includes(search))
            return HttpResponse.json({
              ...storybookProjectPage,
              projects,
              total: projects.length,
            })
          }
        ),
        http.post("/api/auth/organization/set-active", async ({ request }) => {
          const body = (await request.json()) as { organizationId: string }
          await delay(100)
          activeOrganizationId = body.organizationId
          return HttpResponse.json({ organization: storybookOtherOrganization })
        }),
        ...storybookAuthHandlers,
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
    const currentOrganization = await documentBody.findByRole("button", {
      name: `Projects in ${storybookOrganization.name}`,
    })
    currentOrganization.focus()
    await userEvent.keyboard("{ArrowRight}")
    const search = await documentBody.findByRole("textbox", {
      name: "Find project",
    })
    await expect(search).toHaveFocus()
    await expect(
      documentBody.findByRole("link", { name: storybookProject.name })
    ).resolves.toHaveAttribute("aria-current", "true")
    await userEvent.type(search, "Incident")
    await waitFor(() =>
      expect(
        documentBody.queryByRole("link", { name: storybookProject.name })
      ).not.toBeInTheDocument()
    )
    await expect(
      documentBody.findByRole("link", { name: "Incident assistant" })
    ).resolves.toBeVisible()
    await userEvent.type(search, " missing")
    await expect(
      documentBody.findByText("No matching projects.")
    ).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(currentOrganization).toHaveFocus()
    await expect(
      documentBody.getByRole("dialog", { name: "Choose organization" })
    ).toBeVisible()
    await userEvent.click(
      documentBody.getByRole("button", {
        name: `Projects in ${storybookOtherOrganization.name}`,
      })
    )
    const targetProject = await documentBody.findByRole("link", {
      name: otherOrganizationProject.name,
    })
    await expect(targetProject).toHaveAttribute("href", "/p/signal-monitoring")
    await expect(
      documentBody.queryByRole("link", { name: storybookProject.name })
    ).not.toBeInTheDocument()
    await expect(activeOrganizationId).toBe(storybookOrganization.id)
    await expect(navigations).toHaveLength(0)
    await userEvent.click(targetProject)
    await waitFor(() =>
      expect(navigations).toEqual([
        {
          destination: "/p/signal-monitoring",
          organizationId: storybookOtherOrganization.id,
        },
      ])
    )
    await expect(documentBody.queryByRole("dialog")).not.toBeInTheDocument()
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
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await userEvent.click(
      await documentBody.findByRole("button", {
        name: `Projects in ${storybookOrganization.name}`,
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
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await userEvent.click(
      await documentBody.findByRole("button", {
        name: `Projects in ${storybookOrganization.name}`,
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
        ...workspaceProjectHandlers(),
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
    await userEvent.click(
      await body.findByRole("button", {
        name: `Projects in ${storybookOtherOrganization.name}`,
      })
    )
    await expect(
      body.findByRole("link", { name: "View organization" })
    ).resolves.toHaveAttribute("href", "/members")
  },
}

export const OrganizationProjectSelectionError: Story = {
  beforeEach: () => {
    mocked(navigateWorkspace).mockClear()
  },
  parameters: {
    msw: {
      handlers: [
        http.post(
          "/api/auth/organization/set-active",
          () =>
            HttpResponse.json(
              { message: "Unable to switch organizations. Try again." },
              { status: 503 }
            ),
          { once: true }
        ),
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers({
          page: {
            ...storybookProjectPage,
            projects: [otherOrganizationProject],
            total: 1,
          },
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: `Switch organization: ${storybookOrganization.name}`,
      })
    )
    await userEvent.click(
      await body.findByRole("button", {
        name: `Projects in ${storybookOtherOrganization.name}`,
      })
    )
    await userEvent.click(
      await body.findByRole("link", { name: otherOrganizationProject.name })
    )
    await expect(body.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to switch organizations. Try again."
    )
    await expect(mocked(navigateWorkspace)).not.toHaveBeenCalled()
    await expect(
      body.getByRole("textbox", { name: "Find project" })
    ).toBeVisible()
    await userEvent.click(body.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenLastCalledWith(
        "/p/signal-monitoring"
      )
    )
    await expect(body.queryByRole("dialog")).not.toBeInTheDocument()
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

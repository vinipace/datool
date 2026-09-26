import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  apiError,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  storybookOrganization,
  storybookOtherProject,
  storybookProject,
  storybookProjectPage,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import { ProjectsPage } from "./projects-page"

const meta = {
  title: "Workspace/ProjectsPage",
  component: ProjectsPage,
  args: { organization: storybookOrganization },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: workspaceProjectHandlers() },
  },
  render: (args) => (
    <StorybookProjectFrame title="Projects">
      <ProjectsPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ProjectsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(storybookProject.name)
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: `Select ${storybookProject.name}` })
    )
    await expect(
      canvas.getByRole("checkbox", { name: `Select ${storybookProject.name}` })
    ).toBeChecked()
  },
}

export const SearchResult: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/organizations/:organizationId/projects",
          ({ request }) => {
            const search = new URL(request.url).searchParams.get("q")
            const projects = search
              ? [storybookOtherProject]
              : [storybookProject]
            return HttpResponse.json({
              ...storybookProjectPage,
              projects,
              total: projects.length,
            })
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(storybookProject.name)
    await userEvent.type(canvas.getByLabelText("Find projects"), "incident")
    await expect(
      canvas.findByText(storybookOtherProject.name)
    ).resolves.toBeVisible()
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/organizations/:organizationId/projects", () =>
          HttpResponse.json({ ...storybookProjectPage, projects: [], total: 0 })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No projects yet")
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/organizations/:organizationId/projects", async () => {
          await delay("infinite")
          return HttpResponse.json(storybookProjectPage)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading projects")
  },
}

export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/organizations/:organizationId/projects",
          () => apiError("Projects could not be loaded."),
          { once: true }
        ),
        ...workspaceProjectHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Projects could not be loaded."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByText(storybookProject.name)
    ).resolves.toBeVisible()
  },
}

export const CreateProject: Story = {
  parameters: { msw: { handlers: workspaceProjectHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(storybookProject.name)
    await userEvent.click(canvas.getByRole("button", { name: "Project" }))
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await documentBody.findByLabelText("Project name"),
      "Model QA"
    )
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create project" })
    )
    await waitFor(() =>
      expect(documentBody.queryByRole("dialog")).not.toBeInTheDocument()
    )
  },
}

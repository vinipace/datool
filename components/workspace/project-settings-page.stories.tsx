import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  storybookOrganization,
  storybookProject,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import { modelProviderHandlers } from "../../.storybook/scenarios/model-providers"
import { ProjectSettingsPage } from "./project-settings-page"

const endpoint = `/api/projects/${storybookProject.id}`
const meta = {
  title: "Workspace/ProjectSettingsPage",
  component: ProjectSettingsPage,
  args: {
    organization: storybookOrganization,
    project: storybookProject,
    canManage: true,
  },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        ...modelProviderHandlers,
        http.patch(endpoint, async ({ request }) => {
          const body = (await request.json()) as { name: string; slug: string }
          return HttpResponse.json({
            project: { ...storybookProject, ...body },
          })
        }),
      ],
    },
  },
  render: (args) => (
    <StorybookProjectFrame title="Project settings">
      <ProjectSettingsPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ProjectSettingsPage>
export default meta
type Story = StoryObj<typeof meta>

export const SaveName: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().refresh.mockClear()
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.clear(canvas.getByLabelText("Project name"))
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.type(
      canvas.getByLabelText("Project name"),
      "Updated project"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Project settings saved."
    )
    await expect(getRouter().refresh).toHaveBeenCalled()
    await expect(canvas.getByLabelText("Project name")).toHaveValue(
      "Updated project"
    )
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
  },
}

export const SlugNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().replace.mockClear()
    await userEvent.clear(canvas.getByLabelText("Project slug"))
    await userEvent.type(canvas.getByLabelText("Project slug"), "new-slug")
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        "/p/new-slug/settings"
      )
    )
  },
}

export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        ...modelProviderHandlers,
        http.patch(
          endpoint,
          () =>
            HttpResponse.json(
              {
                error: { message: "A project with this slug already exists." },
              },
              { status: 409 }
            ),
          { once: true }
        ),
        http.patch(endpoint, async ({ request }) =>
          HttpResponse.json({
            project: {
              ...storybookProject,
              ...((await request.json()) as object),
            },
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.clear(canvas.getByLabelText("Project slug"))
    await userEvent.type(
      canvas.getByLabelText("Project slug"),
      "another-project"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "A project with this slug already exists."
    )
    await expect(canvas.getByLabelText("Project slug")).toHaveValue(
      "another-project"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Project settings saved."
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const Saving: Story = {
  parameters: {
    msw: {
      handlers: [
        ...modelProviderHandlers,
        http.patch(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json({})
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Project name"), " updated")
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.getByRole("button", { name: /Saving/ })).toBeDisabled()
    await expect(canvas.getByLabelText("Project name")).toBeDisabled()
  },
}

export const ReadOnlyMember: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Project name")).toBeDisabled()
    await expect(canvas.getByLabelText("Project slug")).toBeDisabled()
    await expect(
      canvas.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByLabelText("Project ID")).toHaveValue(
      storybookProject.id
    )
  },
}

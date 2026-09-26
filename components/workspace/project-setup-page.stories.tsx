import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, mocked, userEvent, waitFor, within } from "storybook/test"
import { workspaceProjectHandlers } from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  storybookOrganization,
  storybookProject,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import { navigateWorkspace } from "@/lib/workspace-selection"
import { ProjectSetupPage } from "./project-setup-page"

const meta = {
  title: "Workspace/ProjectSetupPage",
  component: ProjectSetupPage,
  args: { organization: storybookOrganization },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: workspaceProjectHandlers() },
  },
  beforeEach: () => {
    mocked(navigateWorkspace).mockClear()
  },
} satisfies Meta<typeof ProjectSetupPage>

export default meta
type Story = StoryObj<typeof meta>

export const FirstProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("heading", { name: "Create your first project" })
    ).toBeVisible()
    await expect(canvas.getByLabelText("Project name")).toHaveFocus()
    await expect(
      canvas.getByRole("button", { name: "Create project" })
    ).toBeDisabled()
    await userEvent.type(
      canvas.getByLabelText("Project name"),
      "Support copilot"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create project" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenCalledWith(
        "/p/support-copilot/traces"
      )
    )
  },
}

export const Overview: Story = {}

export const CreationRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post(
          "/api/organizations/:organizationId/projects",
          () =>
            HttpResponse.json(
              {
                error: { message: "Unable to create your project. Try again." },
              },
              { status: 503 }
            ),
          { once: true }
        ),
        http.post(
          "/api/organizations/:organizationId/projects",
          async ({ request }) => {
            expect(await request.json()).toEqual({ name: "Support copilot" })
            return HttpResponse.json(
              { project: storybookProject },
              { status: 201 }
            )
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Project name"),
      "Support copilot"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create project" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to create"
    )
    await expect(canvas.getByLabelText("Project name")).toHaveValue(
      "Support copilot"
    )
    await expect(mocked(navigateWorkspace)).not.toHaveBeenCalled()
    await userEvent.click(
      canvas.getByRole("button", { name: "Create project" })
    )
    await waitFor(() =>
      expect(mocked(navigateWorkspace)).toHaveBeenCalledWith(
        "/p/support-copilot/traces"
      )
    )
  },
}

export const Creating: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/organizations/:organizationId/projects", async () => {
          await delay("infinite")
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByLabelText("Project name"),
      "Support copilot"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create project" })
    )
    await expect(canvas.getByLabelText("Project name")).toBeDisabled()
    await expect(
      canvas.getByRole("button", { name: /Create project/ })
    ).toBeDisabled()
  },
}

export const Member: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText(/Ask an organization owner or admin/)
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Create project" })
    ).not.toBeInTheDocument()
  },
}

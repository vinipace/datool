import { useState, type ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http } from "msw"
import { expect, fn, userEvent, within } from "storybook/test"
import {
  apiError,
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { storybookOrganization } from "../../.storybook/scenarios/auth-workspace/fixtures"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

function ControlledDialog({
  kind,
  organization = storybookOrganization,
}: Pick<
  ComponentProps<typeof CreateWorkspaceDialog>,
  "kind" | "organization"
>) {
  const [open, setOpen] = useState(true)
  const [created, setCreated] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {created ? <p role="status">Workspace created</p> : null}
      <CreateWorkspaceDialog
        kind={kind}
        organization={organization}
        open={open}
        onCreated={() => setCreated(true)}
        onOpenChange={setOpen}
      />
    </>
  )
}

const meta = {
  title: "Workspace/CreateWorkspaceDialog",
  component: CreateWorkspaceDialog,
  parameters: { layout: "centered" },
  args: {
    kind: "project",
    organization: storybookOrganization,
    open: true,
    onOpenChange: fn(),
  },
  render: ({ kind, organization }) => (
    <ControlledDialog kind={kind} organization={organization} />
  ),
} satisfies Meta<typeof CreateWorkspaceDialog>

export default meta
type Story = StoryObj<typeof meta>

export const CreateProject: Story = {
  parameters: { msw: { handlers: workspaceProjectHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await documentBody.findByLabelText("Project name"),
      "Model QA"
    )
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create project" })
    )
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Workspace created"
    )
  },
}

export const CreateOrganization: Story = {
  args: { kind: "organization" },
  parameters: { msw: { handlers: storybookAuthHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await documentBody.findByLabelText("Organization name"),
      "Data reliability"
    )
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create organization" })
    )
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Workspace created"
    )
  },
}

export const CreateFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/organizations/:organizationId/projects", () =>
          apiError("A project with this slug already exists.", 409)
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await documentBody.findByLabelText("Project name"),
      "Model QA"
    )
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create project" })
    )
    await expect(documentBody.findByRole("alert")).resolves.toHaveTextContent(
      "A project with this slug already exists."
    )
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { defaultAlertConfig } from "@/src/lib/alerts/contracts"
import { NewAlertPage, EditAlertPage } from "./alert-editor-page"

const endpoint = "/api/projects/alerts-story/alerts/alert-1"
const alert = {
  id: "alert-1",
  revision: 1,
  config: {
    ...defaultAlertConfig,
    name: "Request errors",
    filter: "status = 'errored'",
  },
  createdAt: "2026-09-17T10:00:00Z",
  lastNotifiedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
}
const meta = {
  title: "Workspace/AlertEditorPage",
  component: NewAlertPage,
  args: {
    projectId: "alerts-story",
    projectSlug: "alerts-story",
    canManage: true,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: "/p/alerts-story/alerts/new", query: {} },
    },
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json({ alert, workerOnline: true })
        ),
      ],
    },
  },
  render: (args) => (
    <StorybookProjectFrame
      projectId={args.projectId}
      prefix="/p/alerts-story"
      title="New alert"
      breadcrumbs={[{ label: "Alerts", href: "/p/alerts-story/alerts" }]}
    >
      <NewAlertPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof NewAlertPage>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Create alert" })
    ).toBeDisabled()
    await expect(canvas.getByLabelText("Name", { exact: true })).toHaveValue("")
    await expect(canvas.getByLabelText("SQL filter clause")).toHaveValue("")
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument()
  },
}
export const UnknownTemplate: Story = {
  ...Empty,
  args: { templateId: "unknown" },
}
export const PrefilledTemplate: Story = {
  args: { templateId: "error-burst" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Name", { exact: true })).toHaveValue(
      "Error burst"
    )
    await expect(canvas.getByLabelText("Alert type")).toHaveValue("time_window")
    await expect(canvas.getByLabelText("Minimum matching logs")).toHaveValue(10)
    await expect(canvas.getByLabelText("SQL filter clause")).toHaveValue(
      "resource = 'trace' AND status = 'errored'"
    )
    await userEvent.clear(canvas.getByLabelText("Name", { exact: true }))
    await userEvent.type(
      canvas.getByLabelText("Name", { exact: true }),
      "Custom error burst"
    )
    await expect(canvas.getByLabelText("Name", { exact: true })).toHaveValue(
      "Custom error burst"
    )
    await expect(canvas.queryByRole("radio")).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Create alert" })
    ).toBeEnabled()
  },
}
export const InvalidFilter: Story = {
  args: { templateId: "request-failures" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.clear(canvas.getByLabelText("SQL filter clause"))
    await userEvent.type(
      canvas.getByLabelText("SQL filter clause"),
      "status = 'errored'; SELECT 1"
    )
    await expect(canvas.getByRole("alert")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Create alert" })
    ).toBeDisabled()
  },
}
export const Edit: Story = {
  render: (args) => (
    <StorybookProjectFrame
      projectId={args.projectId}
      prefix="/p/alerts-story"
      title="Edit alert"
    >
      <EditAlertPage {...args} alertId="alert-1" />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByLabelText("Name", { exact: true })
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.type(name, " changed")
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeEnabled()
    await userEvent.clear(name)
    await userEvent.type(name, "Request errors")
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await expect(
      canvas.queryByText("Start with a template")
    ).not.toBeInTheDocument()
  },
}
export const SaveError: Story = {
  ...Edit,
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json({ alert, workerOnline: true })
        ),
        http.patch(endpoint, () =>
          HttpResponse.json(
            { error: { message: "Alert changed. Refresh and try again." } },
            { status: 409 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByLabelText("Name", { exact: true })
    await userEvent.type(name, " draft")
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Alert changed."
    )
    await expect(name).toHaveValue("Request errors draft")
  },
}
export const Loading: Story = {
  ...Edit,
  play: undefined,
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json({ alert })
        }),
      ],
    },
  },
}
export const MissingAlert: Story = {
  ...Edit,
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json(
            { error: { message: "Alert not found." } },
            { status: 404 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Alert not found."
    )
    await expect(
      canvas.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument()
  },
}
export const ReadOnly: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/Only project owners and admins/)
    ).toBeVisible()
    await expect(
      within(canvasElement).queryByRole("button", { name: "Create alert" })
    ).not.toBeInTheDocument()
  },
}

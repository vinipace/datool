import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { OrganizationSettingsPage } from "./organization-settings-page"

const organization = {
  id: "org-settings",
  name: "Datool demo",
  slug: "datool-demo",
}
const endpoint = "/api/auth/organization/update"
const save = http.post(endpoint, async ({ request }) => {
  const body = (await request.json()) as {
    organizationId: string
    data: { name: string; slug: string }
  }
  return body.organizationId === organization.id
    ? HttpResponse.json({ ...organization, ...body.data })
    : HttpResponse.json({ message: "Wrong organization" }, { status: 400 })
})
const meta = {
  title: "Workspace/OrganizationSettingsPage",
  component: OrganizationSettingsPage,
  args: { organization, canManage: true },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/settings/general" } },
    msw: { handlers: [save] },
  },
} satisfies Meta<typeof OrganizationSettingsPage>
export default meta
type Story = StoryObj<typeof meta>

export const SaveDetails: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().refresh.mockClear()
    await expect(canvas.getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.clear(canvas.getByLabelText("Organization name"))
    await userEvent.type(
      canvas.getByLabelText("Organization name"),
      "Renamed team"
    )
    await userEvent.clear(canvas.getByLabelText("Organization slug"))
    await userEvent.type(
      canvas.getByLabelText("Organization slug"),
      "renamed-team"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Organization settings saved."
    )
    await expect(
      canvas.getByRole("button", { name: "Switch organization: Renamed team" })
    ).toBeVisible()
    await expect(canvas.getByLabelText("Organization slug")).toHaveValue(
      "renamed-team"
    )
    await expect(canvas.getByLabelText("Organization ID")).toHaveValue(
      organization.id
    )
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await expect(getRouter().refresh).toHaveBeenCalled()
  },
}

export const ValidationAndReset: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = canvas.getByLabelText("Organization name")
    const slug = canvas.getByLabelText("Organization slug")
    await userEvent.clear(name)
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.type(name, "Changed")
    await userEvent.clear(slug)
    await userEvent.type(slug, "bad--slug")
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: "Reset changes" }))
    await expect(name).toHaveValue(organization.name)
    await expect(slug).toHaveValue(organization.slug)
  },
}

export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post(
          endpoint,
          () =>
            HttpResponse.json(
              { message: "Organization slug already taken" },
              { status: 400 }
            ),
          { once: true }
        ),
        save,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.clear(canvas.getByLabelText("Organization slug"))
    await userEvent.type(
      canvas.getByLabelText("Organization slug"),
      "another-team"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Organization slug already taken"
    )
    await expect(canvas.getByLabelText("Organization slug")).toHaveValue(
      "another-team"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Organization settings saved."
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const Saving: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json({})
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Organization name"), " updated")
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }))
    await expect(canvas.getByRole("button", { name: "Saving…" })).toBeDisabled()
    await expect(canvas.getByLabelText("Organization name")).toBeDisabled()
    await expect(canvas.getByLabelText("Organization slug")).toBeDisabled()
  },
}

export const ReadOnlyMember: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Organization name")).toBeDisabled()
    await expect(canvas.getByLabelText("Organization slug")).toBeDisabled()
    await expect(
      canvas.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByText(/Only organization owners and admins/)
    ).toBeVisible()
  },
}

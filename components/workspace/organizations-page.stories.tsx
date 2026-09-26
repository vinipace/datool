import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  betterAuthError,
  storybookAuthHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { storybookOrganizationRows } from "../../.storybook/scenarios/auth-workspace/fixtures"
import { OrganizationsPage } from "./organizations-page"

const meta = {
  title: "Workspace/OrganizationsPage",
  component: OrganizationsPage,
  args: { initialOrganizations: storybookOrganizationRows },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: storybookAuthHandlers },
  },
} satisfies Meta<typeof OrganizationsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Northstar Labs")).toBeVisible()
    await expect(canvas.getByText("1.5k traces")).toBeVisible()
    await expect(canvas.getByText("284 traces")).toBeVisible()
    await expect(canvas.getByText("Pro", { exact: true })).toBeVisible()
    await expect(canvas.getByText("Core", { exact: true })).toBeVisible()
    await expect(canvas.getByRole("img", { name: "Datool" })).toBeVisible()
    const organization = canvas.getByRole("button", {
      name: "Open Northstar Labs",
    })
    organization.focus()
    await expect(organization).toHaveFocus()
    await expect(
      canvas.getByRole("button", { name: "API keys for Northstar Labs" })
    ).toBeVisible()
  },
}

export const Empty: Story = {
  args: { initialOrganizations: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Create an organization to get started.")
    ).toBeVisible()
  },
}

export const NoPlan: Story = {
  args: {
    initialOrganizations: [
      {
        ...storybookOrganizationRows[0],
        plan: null,
        projectCount: 0,
        traceCount: 0,
      },
    ],
  },
}

export const SelfHosted: Story = {
  args: { billingEnabled: false },
}

export const CreateOrganization: Story = {
  args: { initialOrganizations: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("link", { name: "New organization" })
    ).toHaveAttribute("href", "/organizations/new")
    await expect(
      canvas.queryByLabelText("Organization name")
    ).not.toBeInTheDocument()
  },
}

export const SelectionFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/organization/set-active", () =>
          betterAuthError(
            "Unable to select this organization.",
            403,
            "ORGANIZATION_ACCESS_DENIED"
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Open Northstar Labs" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to select this organization."
    )
  },
}

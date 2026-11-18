import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import {
  ShopifyOnboarding,
  ShopifyBillingReturn,
  ShopifyBillingStart,
} from "./shopify-onboarding"

const meta = {
  title: "Workspace/ShopifyOnboarding",
  component: ShopifyOnboarding,
  args: {
    shop: "sample.myshopify.com",
    organizations: [
      {
        id: "existing",
        name: "Existing Datool customer",
        projects: [{ id: "store", name: "Store assistant" }],
      },
    ],
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShopifyOnboarding>
export default meta
type Story = StoryObj<typeof meta>
export const NewCustomer: Story = {
  args: { organizations: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Connect store" })
    ).toBeDisabled()
    await userEvent.type(canvas.getByLabelText("Organization name"), "My store")
    await userEvent.click(canvas.getByRole("checkbox"))
    await expect(
      canvas.getByRole("button", { name: "Connect store" })
    ).toBeEnabled()
    await expect(
      canvas.getByText(/Connecting does not create a charge/)
    ).toBeVisible()
  },
}
export const ExistingProject: Story = {
  args: { projectId: "store" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("radio", { name: "Existing Datool customer" })
    ).toBeChecked()
    await expect(
      canvas.queryByRole("radio", { name: "Create an organization" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("checkbox"))
    await expect(
      canvas.getByRole("button", { name: "Connect store" })
    ).toBeEnabled()
  },
}
export const RetryConnection: Story = {
  args: { projectId: "store" },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/shopify/claim", () =>
          HttpResponse.json(
            { error: { message: "Connection temporarily unavailable." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("checkbox"))
    await userEvent.click(canvas.getByRole("button", { name: "Connect store" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Connection temporarily unavailable."
    )
    await expect(
      canvas.getByRole("radio", { name: "Existing Datool customer" })
    ).toBeChecked()
    await expect(
      canvas.getByRole("button", { name: "Connect store" })
    ).toBeEnabled()
  },
}

export const ReturnFromShopify: Story = {
  render: () => (
    <ShopifyBillingReturn
      organizationId="existing"
      organizationName="Store team"
      shop="sample.myshopify.com"
    />
  ),
}

export const SeparateSubscription: Story = {
  args: {
    organizations: [
      {
        id: "existing",
        name: "Existing team",
        projects: [],
        billingConflict: true,
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("radio", { name: /Existing team/ })
    ).toBeDisabled()
    await expect(
      canvas.getByRole("radio", { name: "Create an organization" })
    ).toBeChecked()
    await expect(canvas.getByLabelText("Organization name")).toBeVisible()
  },
}
export const ChooseShopifyOrganization: Story = {
  render: () => (
    <ShopifyBillingStart
      organizations={[{ id: "shop", name: "Northstar Store" }]}
      installUrl="https://apps.shopify.com/datool"
    />
  ),
}
export const ConnectFirstStore: Story = {
  render: () => (
    <ShopifyBillingStart
      organizations={[]}
      installUrl="https://apps.shopify.com/datool"
    />
  ),
}
export const StoreConnectionUnavailable: Story = {
  render: () => <ShopifyBillingStart organizations={[]} installUrl={null} />,
}

export const RetryOpeningOrganization: Story = {
  ...ChooseShopifyOrganization,
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/organization/set-active", () =>
          HttpResponse.json({ message: "Unavailable" }, { status: 503 })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Northstar Store" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Could not open your organization. Please try again."
    )
    await expect(
      canvas.getByRole("button", { name: "Northstar Store" })
    ).toBeEnabled()
  },
}

import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { IntegrationsTab } from "./integrations-tab"
import { appIntegrationScenario } from "@/.storybook/scenarios/app-integrations"

const active = appIntegrationScenario()
const empty = appIntegrationScenario("empty")
const pending = appIntegrationScenario("pending")
const catalog = appIntegrationScenario("catalog")
const disconnect = appIntegrationScenario()
const connectError = appIntegrationScenario("connect-error")
const shopify = appIntegrationScenario("shopify")
const meta = {
  title: "Build/AgentIntegrations",
  component: IntegrationsTab,
  args: { agentId: "calendar-agent" },
  parameters: { layout: "fullscreen", msw: { handlers: active.handlers } },
} satisfies Meta<typeof IntegrationsTab>
export default meta
type Story = StoryObj<typeof meta>
export const Shopify: Story = {
  parameters: { msw: { handlers: shopify.handlers } },
  beforeEach: shopify.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Connect$/ })
    )
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Shopify",
      })
    )
    await expect(
      dialog.queryByLabelText("Store address")
    ).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole("button", { name: "Connect store" }))
    await expect(
      dialog.findByRole("link", { name: "Continue to Shopify" })
    ).resolves.toHaveAttribute(
      "href",
      "https://datool.example/api/shopify/install?intent=fixture"
    )
  },
}
export const ShopifySetupRequired: Story = {
  parameters: {
    msw: { handlers: appIntegrationScenario("shopify-unconfigured").handlers },
  },
}
export const Connected: Story = {
  beforeEach: active.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const manage = await canvas.findByRole("button", { name: "Manage" })
    await userEvent.click(manage)
    const page = within(canvasElement.ownerDocument.body)
    const dialog = within(
      await page.findByRole("dialog", { name: "Google Calendar" })
    )
    await expect(dialog.getByText("Connected", { exact: true })).toBeVisible()
    await expect(
      dialog.findByRole("switch", { name: "Enable List calendar events" })
    ).resolves.toBeVisible()
    await userEvent.click(dialog.getByRole("button", { name: /Options for/ }))
    await expect(
      page.getByRole("menuitem", { name: "Check connection" })
    ).toBeVisible()
    await expect(
      page.getByRole("menuitem", { name: "Disconnect" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(page.getByRole("dialog")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    await expect(manage).toHaveFocus()
  },
}
export const Empty: Story = {
  parameters: { msw: { handlers: empty.handlers } },
  beforeEach: empty.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Connect$/ })
    )
    const page = within(canvasElement.ownerDocument.body)
    const dialog = within(await page.findByRole("dialog"))
    await expect(
      dialog.findByRole("link", { name: "Authorize account" })
    ).resolves.toBeVisible()
    await userEvent.click(
      await dialog.findByRole("button", { name: "Check connection" })
    )
    await expect(
      dialog.findByText("Connected", { exact: true })
    ).resolves.toBeInTheDocument()
    await expect(
      dialog.queryByRole("link", { name: "Authorize account" })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await expect(canvas.getByRole("button", { name: "Manage" })).toBeVisible()
  },
}
export const Pending: Story = {
  parameters: { msw: { handlers: pending.handlers } },
  beforeEach: pending.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog")
    )
    await expect(dialog.getByText("Awaiting authorization")).toBeVisible()
    await expect(
      dialog.queryByRole("switch", { name: "Enable List calendar events" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      dialog.getByRole("button", { name: "Check connection" })
    )
    await expect(
      dialog.findByRole("switch", { name: "Enable List calendar events" })
    ).resolves.toBeVisible()
  },
}
export const Disabled: Story = {
  parameters: {
    msw: { handlers: appIntegrationScenario("disabled").handlers },
  },
}
export const Loading: Story = {
  parameters: { msw: { handlers: appIntegrationScenario("loading").handlers } },
}
export const Error: Story = {
  parameters: { msw: { handlers: appIntegrationScenario("error").handlers } },
}
export const Catalog: Story = {
  parameters: { msw: { handlers: catalog.handlers } },
  beforeEach: catalog.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const calendar = within(
      await canvas.findByRole("group", { name: "Google Calendar" })
    )
    await userEvent.click(calendar.getByRole("button", { name: "Manage" }))
    const page = within(canvasElement.ownerDocument.body)
    let dialog = within(
      await page.findByRole("dialog", { name: "Google Calendar" })
    )
    await expect(dialog.getByText("Connected", { exact: true })).toBeVisible()
    await expect(
      dialog.queryByRole("group", { name: /Slack/ })
    ).not.toBeInTheDocument()
    await expect(dialog.queryByText("Awaiting authorization")).not.toBeVisible()
    await userEvent.click(dialog.getByText("Other connections (1)"))
    await expect(dialog.getByText("Awaiting authorization")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      within(canvas.getByRole("group", { name: "Slack" })).getByRole("button", {
        name: "Manage",
      })
    )
    dialog = within(await page.findByRole("dialog", { name: "Slack" }))
    await expect(
      dialog.getByRole("group", { name: "Slack account" })
    ).toBeVisible()
    await expect(
      dialog.queryByRole("group", { name: /Google Calendar/ })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await expect(
      within(canvas.getByRole("group", { name: "Shopify" })).getByRole(
        "button",
        { name: "Connect" }
      )
    ).toBeVisible()
  },
}
export const ConnectFailure: Story = {
  parameters: { msw: { handlers: connectError.handlers } },
  beforeEach: connectError.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect" })
    )
    const page = within(canvasElement.ownerDocument.body)
    const dialog = within(await page.findByRole("dialog"))
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to start authorization."
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Connect account" })
    )
    await expect(
      dialog.findByRole("link", { name: "Authorize account" })
    ).resolves.toBeVisible()
    await expect(dialog.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const DisconnectAccount: Story = {
  parameters: { msw: { handlers: disconnect.handlers } },
  beforeEach: disconnect.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Manage" }))
    const page = within(canvasElement.ownerDocument.body)
    const dialog = within(await page.findByRole("dialog"))
    const options = dialog.getByRole("button", { name: /Options for/ })
    await userEvent.click(options)
    await userEvent.click(page.getByRole("menuitem", { name: "Disconnect" }))
    let confirmation = within(await page.findByRole("alertdialog"))
    await waitFor(() =>
      expect(confirmation.getByRole("button", { name: "Cancel" })).toHaveFocus()
    )
    await expect(
      confirmation.getByText(/Every agent in this project will lose access/)
    ).toBeVisible()
    await userEvent.click(confirmation.getByRole("button", { name: "Cancel" }))
    await expect(page.queryByRole("alertdialog")).not.toBeInTheDocument()
    await expect(options).toHaveFocus()
    await expect(dialog.getByText("Connected", { exact: true })).toBeVisible()
    await userEvent.click(options)
    await userEvent.click(page.getByRole("menuitem", { name: "Disconnect" }))
    confirmation = within(await page.findByRole("alertdialog"))
    await userEvent.click(
      confirmation.getByRole("button", { name: "Disconnect account" })
    )
    await expect(
      dialog.findByRole("button", { name: "Connect account" })
    ).resolves.toBeVisible()
    await expect(
      dialog.queryByRole("switch", { name: "Enable List calendar events" })
    ).not.toBeInTheDocument()
  },
}

const customMcp = appIntegrationScenario("custom-mcp")
export const CustomMcp: Story = {
  parameters: { msw: { handlers: customMcp.handlers } },
  beforeEach: customMcp.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Add custom MCP" })
      ).toBeEnabled()
    )
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add custom MCP" })
    )
    let dialog = within(
      await page.findByRole("dialog", { name: "Add custom MCP" })
    )
    await expect(dialog.getByLabelText("Authentication")).toHaveValue("oauth")
    await expect(
      dialog.getByRole("button", { name: "Continue with OAuth" })
    ).toBeVisible()
    await expect(
      dialog.queryByLabelText("Access token")
    ).not.toBeInTheDocument()
    await userEvent.type(dialog.getByLabelText("Name"), "Customer records")
    await userEvent.type(
      dialog.getByLabelText("Server URL"),
      "https://records.example.com/mcp"
    )
    await userEvent.selectOptions(
      dialog.getByLabelText("Authentication"),
      "token"
    )
    await userEvent.type(
      dialog.getByLabelText("Access token"),
      "fixture-secret"
    )
    await userEvent.click(dialog.getByRole("button", { name: "Connect MCP" }))
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    )
    const row = within(
      await canvas.findByRole("group", { name: "Customer records" })
    )
    await expect(row.getByText("https://records.example.com/mcp")).toBeVisible()
    await userEvent.click(row.getByRole("button", { name: "Manage" }))
    dialog = within(
      await page.findByRole("dialog", { name: "Customer records" })
    )
    await expect(dialog.getByLabelText("Access token")).toHaveValue("")
    await userEvent.click(
      dialog.getByRole("button", { name: "Check connection" })
    )
    await expect(dialog.findByRole("status")).resolves.toHaveTextContent(
      "Connection checked"
    )
    await userEvent.clear(dialog.getByLabelText("Name"))
    await userEvent.type(dialog.getByLabelText("Name"), "Sales records")
    await userEvent.click(
      dialog.getByRole("button", { name: "Save connection" })
    )
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await userEvent.click(
      within(
        await canvas.findByRole("group", { name: "Sales records" })
      ).getByRole("button", { name: "Manage" })
    )
    dialog = within(await page.findByRole("dialog", { name: "Sales records" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Disconnect MCP account" })
    )
    let confirmation = within(await page.findByRole("alertdialog"))
    await waitFor(() =>
      expect(confirmation.getByRole("button", { name: "Cancel" })).toHaveFocus()
    )
    await userEvent.keyboard("{Escape}")
    await expect(
      dialog.getByRole("button", { name: "Disconnect MCP account" })
    ).toHaveFocus()
    await userEvent.click(
      dialog.getByRole("button", { name: "Disconnect MCP account" })
    )
    confirmation = within(await page.findByRole("alertdialog"))
    await userEvent.click(
      confirmation.getByRole("button", { name: "Disconnect account" })
    )
    await waitFor(() =>
      expect(page.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    await expect(
      within(canvas.getByRole("group", { name: "Sales records" })).getByText(
        "Disconnected"
      )
    ).toBeVisible()
  },
}

import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { IntegrationActionFields } from "./integration-action-fields"
import { newActionDraft } from "./action-presets"
import type { ActionDefinition } from "@/src/lib/build/contracts"
import {
  appIntegrationScenario,
  connectionId,
} from "@/.storybook/scenarios/app-integrations"

const draft = newActionDraft("integration") as Extract<
  ActionDefinition,
  { type: "integration" }
>
function Editor(args: {
  draft: typeof draft
  onManageIntegrations: () => void
}) {
  const [value, setValue] = useState(args.draft)
  return (
    <div className="mx-auto max-w-xl bg-background p-6 text-foreground">
      <IntegrationActionFields
        draft={value}
        onChange={setValue}
        onManageIntegrations={args.onManageIntegrations}
      />
    </div>
  )
}
const connected = appIntegrationScenario()
const empty = appIntegrationScenario("empty")
const shopify = appIntegrationScenario("shopify-active")
const meta = {
  title: "Build/IntegrationActionFields",
  component: Editor,
  args: { draft: { ...draft, connectionId }, onManageIntegrations: fn() },
  parameters: { layout: "fullscreen", msw: { handlers: connected.handlers } },
} satisfies Meta<typeof Editor>
export default meta
type Story = StoryObj<typeof meta>
export const Connected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const action = await canvas.findByLabelText("App action")
    await canvas.findByRole("option", { name: "List calendar events" })
    await userEvent.selectOptions(action, "GOOGLECALENDAR_EVENTS_LIST")
    await expect(action).toHaveValue("GOOGLECALENDAR_EVENTS_LIST")
    await expect(
      canvas.queryByRole("button", { name: /^Connect$/ })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Disconnect" })
    ).not.toBeInTheDocument()
  },
}
export const Empty: Story = {
  args: { draft },
  parameters: { msw: { handlers: empty.handlers } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(
      "Connect an account in Integrations before choosing an app action."
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Manage integrations" })
    )
    await expect(args.onManageIntegrations).toHaveBeenCalledOnce()
  },
}

export const ShopifyTags: Story = {
  parameters: {
    msw: { handlers: shopify.handlers },
    viewport: { defaultViewport: "mobile1" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("option", { name: "Tag an order" })
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_TAG_ORDER"
    )
    const tags = canvas.getByLabelText("Allowed order tags")
    await userEvent.type(tags, "support-requested, follow-up")
    await userEvent.tab()
    await expect(tags).toHaveValue("support-requested, follow-up")
    const approval = canvas.getByRole("switch", {
      name: "Require teammate approval",
    })
    await userEvent.click(approval)
    await expect(approval).toBeChecked()
  },
}

export const ShopifyProducts: Story = {
  parameters: { msw: { handlers: shopify.handlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("option", { name: "Search products" })
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_SEARCH_PRODUCTS"
    )
    const stock = canvas.getByRole("switch", {
      name: "Exclude out-of-stock products",
    })
    await expect(stock).not.toBeChecked()
    await userEvent.click(stock)
    await expect(stock).toBeChecked()
  },
}

export const ShopifyOrder: Story = {
  parameters: { msw: { handlers: shopify.handlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("option", { name: "Create order" })
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_CREATE_ORDER"
    )
    const payment = canvas.getByLabelText("Payment")
    await expect(payment).toHaveValue("online")
    await userEvent.selectOptions(payment, "cash_on_delivery")
    await expect(payment).toHaveValue("cash_on_delivery")
    await userEvent.selectOptions(payment, "free")
    await expect(payment).toHaveValue("free")
    await userEvent.selectOptions(canvas.getByLabelText("Order items"), "cart")
    await expect(canvas.getByLabelText("Order items")).toHaveValue("cart")
    await userEvent.selectOptions(
      canvas.getByLabelText("Delivery phone"),
      "required"
    )
    await expect(canvas.getByLabelText("Delivery phone")).toHaveValue(
      "required"
    )
    await userEvent.type(
      canvas.getByLabelText("Order tags"),
      "support, replacement"
    )
    await userEvent.tab()
    await expect(canvas.getByLabelText("Order tags")).toHaveValue(
      "support, replacement"
    )
    await userEvent.type(canvas.getByLabelText("Order note"), "Approved gift")
    await expect(canvas.getByLabelText("Order note")).toHaveValue(
      "Approved gift"
    )
    const approval = canvas.getByRole("switch", {
      name: "Require teammate approval",
    })
    await userEvent.click(approval)
    await expect(approval).toBeChecked()
  },
}

export const ShopifyReturns: Story = {
  parameters: { msw: { handlers: shopify.handlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("option", { name: "Return or exchange items" })
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_RETURN_OR_EXCHANGE"
    )
    const window = canvas.getByLabelText("Return window (days)")
    await expect(window).toHaveValue(30)
    await userEvent.clear(window)
    await userEvent.tab()
    await expect(window).toHaveValue(null)
    await userEvent.type(window, "60")
    await userEvent.tab()
    await expect(window).toHaveValue(60)
    const exchanges = canvas.getByRole("switch", { name: "Allow exchanges" })
    await expect(exchanges).not.toBeChecked()
    await userEvent.click(exchanges)
    await expect(exchanges).toBeChecked()
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_CREATE_EXCHANGE_ORDER"
    )
    await expect(
      canvas.getByText("Teammate approval is always required")
    ).toBeVisible()
    await expect(
      canvas.queryByRole("switch", { name: "Require teammate approval" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByText(/Preview only: replacement exchanges/)
    ).toBeVisible()
    await userEvent.selectOptions(
      canvas.getByLabelText("App action"),
      "SHOPIFY_RETURN_OR_EXCHANGE"
    )
    const optionalApproval = canvas.getByRole("switch", {
      name: "Require teammate approval",
    })
    await expect(optionalApproval).not.toBeDisabled()
    await expect(optionalApproval).not.toBeChecked()
  },
}

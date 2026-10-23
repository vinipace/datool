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

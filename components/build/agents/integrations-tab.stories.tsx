import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { IntegrationsTab } from "./integrations-tab"
import {
  appIntegrationScenario,
  connectionId,
} from "@/.storybook/scenarios/app-integrations"

const active = appIntegrationScenario()
const empty = appIntegrationScenario("empty")
const pending = appIntegrationScenario("pending")
const meta = {
  title: "Build/AgentIntegrations",
  component: IntegrationsTab,
  parameters: { layout: "fullscreen", msw: { handlers: active.handlers } },
} satisfies Meta<typeof IntegrationsTab>
export default meta
type Story = StoryObj<typeof meta>
export const Connected: Story = {
  beforeEach: active.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(
      await canvas.findByLabelText("Connected account"),
      connectionId
    )
    await expect(
      canvas.getByRole("button", { name: "Refresh connection" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Disconnect" })
    ).toBeVisible()
  },
}
export const Empty: Story = {
  parameters: { msw: { handlers: empty.handlers } },
  beforeEach: empty.reset,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(
      await canvas.findByLabelText("Connect an app"),
      "googlecalendar"
    )
    await userEvent.click(canvas.getByRole("button", { name: /^Connect$/ }))
    await expect(
      canvas.findByRole("link", { name: "Authorize the app in a new tab" })
    ).resolves.toBeVisible()
    await userEvent.click(
      await canvas.findByRole("button", { name: "Refresh connection" })
    )
    await expect(
      canvas.findByRole("option", { name: /Google Calendar · active/ })
    ).resolves.toBeInTheDocument()
    await expect(
      canvas.queryByRole("link", { name: "Authorize the app in a new tab" })
    ).not.toBeInTheDocument()
  },
}
export const Pending: Story = {
  parameters: { msw: { handlers: pending.handlers } },
  beforeEach: pending.reset,
  play: Connected.play,
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

import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { IntegrationActionFields } from "./integration-action-fields"
import { newActionDraft } from "./action-presets"
import type { ActionDefinition } from "@/src/lib/build/contracts"

const connectionId = "e35e42aa-f025-4a7e-90af-bb53fe130d79"
const draft = newActionDraft("integration") as Extract<
  ActionDefinition,
  { type: "integration" }
>
function Editor(args: { draft: typeof draft }) {
  const [value, setValue] = useState(args.draft)
  return (
    <div className="mx-auto max-w-xl bg-background p-6 text-foreground">
      <IntegrationActionFields draft={value} onChange={setValue} />
    </div>
  )
}
const handler = (
  state: "pending" | "active" | "empty" | "disabled" | "error" | "loading"
) =>
  http.post("*/api/build/:operation", async ({ params }) => {
    if (state === "loading") await delay("infinite")
    if (state === "error")
      return HttpResponse.json(
        { error: { message: "Unable to load app connections." } },
        { status: 503 }
      )
    if (params.operation === "build_list_app_connections")
      return HttpResponse.json({
        data: {
          configured: state !== "disabled",
          apps: [{ slug: "googlecalendar", name: "Google Calendar" }],
          connections: ["empty", "disabled"].includes(state)
            ? []
            : [
                {
                  id: connectionId,
                  toolkit: "googlecalendar",
                  label: "Google Calendar",
                  status: state,
                },
              ],
        },
      })
    if (params.operation === "build_list_app_tools")
      return HttpResponse.json({
        data: [
          {
            slug: "GOOGLECALENDAR_EVENTS_LIST",
            name: "List calendar events",
            description: "Look up scheduled events.",
            inputSchema: {
              type: "object",
              properties: { calendar_id: { type: "string" } },
            },
          },
        ],
      })
    if (params.operation === "build_connect_app")
      return HttpResponse.json({
        data: {
          id: connectionId,
          redirectUrl: "https://connect.composio.dev/fixture",
        },
      })
    return HttpResponse.json({ data: {} })
  })
const meta = {
  title: "Build/IntegrationActionFields",
  component: Editor,
  args: { draft: { ...draft, connectionId } },
  parameters: { layout: "fullscreen", msw: { handlers: [handler("active")] } },
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
  },
}
export const Empty: Story = {
  args: { draft },
  parameters: { msw: { handlers: [handler("empty")] } },
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
  },
}
export const Pending: Story = {
  parameters: { msw: { handlers: [handler("pending")] } },
}
export const Disabled: Story = {
  parameters: { msw: { handlers: [handler("disabled")] } },
}
export const Loading: Story = {
  parameters: { msw: { handlers: [handler("loading")] } },
}
export const Error: Story = {
  parameters: { msw: { handlers: [handler("error")] } },
}

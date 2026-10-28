import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { ChannelConnection } from "@/src/lib/build/channels"
import { WhatsAppEditor } from "./whatsapp-editor"

const agent: ManagedAgent = {
  id: "support-agent",
  projectId: "demo",
  slug: "support",
  name: "Acme Support",
  description: "",
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({ model: "fixture-model" }),
  createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
  archivedAt: null,
}
const connection: ChannelConnection = {
  id: "whatsapp-demo",
  projectId: "demo",
  organizationId: "demo",
  agentId: agent.id,
  channel: "whatsapp",
  label: "WhatsApp",
  status: "connected",
  externalId: null,
  config: {},
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
}
function handlers({
  status = "connected",
  mode = "cloud",
  state = "ready",
  empty = false,
  configured = true,
}: {
  status?: string
  mode?: string
  state?: "ready" | "loading" | "error"
  empty?: boolean
  configured?: boolean
} = {}) {
  let connectionStatus = status
  const conversations = new Map<
    string,
    Array<{ id: string; role: string; content: string }>
  >()
  return [
    http.post("/api/build/:operation", async ({ params, request }) => {
      const input = (await request.json()) as Record<string, string>
      if (params.operation === "build_create_conversation") {
        const id = input.externalConversationId
        if (!conversations.has(id)) conversations.set(id, [])
        return HttpResponse.json({ data: { id } })
      }
      if (params.operation === "build_list_conversation_messages") {
        return HttpResponse.json({
          data: { items: conversations.get(input.conversationId) ?? [] },
        })
      }
      if (params.operation === "build_run_agent_turn") {
        const messages = conversations.get(input.conversationId)
        if (
          !messages ||
          input.agentId !== agent.id ||
          input.channel !== "web"
        ) {
          return HttpResponse.json(
            { error: { message: "Invalid preview conversation." } },
            { status: 400 }
          )
        }
        await delay(500)
        if (input.message === "Fail this turn") {
          return HttpResponse.json(
            {
              error: {
                message: "The model is temporarily unavailable. Try again.",
              },
            },
            { status: 503 }
          )
        }
        messages.push(
          { id: crypto.randomUUID(), role: "user", content: input.message },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "This is a demo reply. In the app, your applied agent answers here.",
          }
        )
        return HttpResponse.json({ data: {} })
      }
      if (state === "loading") await delay("infinite")
      if (state === "error")
        return HttpResponse.json(
          { error: { message: "Could not reach WhatsApp. Try again." } },
          { status: 503 }
        )
      switch (params.operation) {
        case "build_update_channel_status":
          connectionStatus = input.status
          return HttpResponse.json({ data: {} })
        case "build_refresh_whatsapp_connection":
          return HttpResponse.json({ data: {} })
        case "build_get_whatsapp_setup":
          return HttpResponse.json({
            data: {
              configured,
              missing: [],
              appId: "fixture",
              configId: "fixture",
              graphVersion: "fixture",
              webhookUrl: null,
            },
          })
        case "build_get_whatsapp_connection":
          return HttpResponse.json({
            data: {
              status: connectionStatus,
              account: {
                displayPhoneNumber: "+1 202 555 0147",
                verifiedName: "Acme Support",
                mode,
                tokenExpiresAt: null,
                sync: {},
              },
            },
          })
        case "build_list_whatsapp_templates":
          return HttpResponse.json({
            data: {
              items: empty
                ? []
                : [
                    {
                      id: "order-update",
                      name: "order_update",
                      language: "en_US",
                      category: "UTILITY",
                      status: "APPROVED",
                    },
                  ],
              nextCursor: null,
            },
          })
        default:
          return HttpResponse.json(
            {
              error: { message: "This preview does not change your channel." },
            },
            { status: 400 }
          )
      }
    }),
  ]
}
const meta = {
  title: "Build/Channels/WhatsApp",
  component: WhatsAppEditor,
  args: { connection, agent, fromAgent: false },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: "/p/demo/build/integrations/whatsapp-demo" },
    },
    msw: { handlers: handlers() },
  },
  decorators: [
    (Story) => (
      <div className="h-dvh bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WhatsAppEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Connected: Story = {}
export const EmptyTemplates: Story = {
  parameters: { msw: { handlers: handlers({ empty: true }) } },
}
export const Paused: Story = {
  parameters: {
    msw: { handlers: handlers({ status: "paused", mode: "coexistence" }) },
  },
}
export const Setup: Story = { args: { connection: null } }
export const SetupRequired: Story = {
  args: { connection: null },
  parameters: { msw: { handlers: handlers({ configured: false }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const connect = await canvas.findByRole("button", {
      name: "Connect with Meta",
    })
    await expect(connect).toBeEnabled()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.clear(canvas.getByRole("textbox", { name: "Channel name" }))
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Channel name" }),
      "Support"
    )
    await userEvent.click(connect)
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "WhatsApp isn’t configured on this Datool installation."
    )
    await expect(
      canvas.getByRole("textbox", { name: "Channel name" })
    ).toHaveValue("Support")
    await expect(connect).toBeEnabled()
  },
}
export const Loading: Story = {
  parameters: { msw: { handlers: handlers({ state: "loading" }) } },
}
export const Error: Story = {
  parameters: { msw: { handlers: handlers({ state: "error" }) } },
}

// Owns the WhatsApp phone integration: real composer, preview transport,
// conversation readback and reset. PublicChat's other stories own its lifecycle.
export const AgentTest: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const message = await canvas.findByRole("textbox", {
      name: "Message",
    })
    const send = canvas.getByRole("button", {
      name: "Send message",
    })
    const reset = canvas.getByRole("button", { name: "New test conversation" })
    await waitFor(() => expect(reset).toBeEnabled())
    await userEvent.type(message, "Hello from the phone")
    await userEvent.click(send)
    await expect(reset).toBeDisabled()
    await waitFor(() =>
      expect(
        canvas.getByText(
          "This is a demo reply. In the app, your applied agent answers here."
        )
      ).toBeVisible()
    )
    await waitFor(() =>
      expect(canvas.getByText("Hello from the phone")).toBeVisible()
    )
    await expect(message).toHaveValue("")
    await userEvent.type(message, "Fail this turn")
    await userEvent.keyboard("{Enter}")
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The model is temporarily unavailable."
    )
    await expect(message).toHaveValue("Fail this turn")
    await userEvent.click(reset)
    await waitFor(() => expect(reset).toBeEnabled())
    await expect(
      canvas.queryByText("Hello from the phone")
    ).not.toBeInTheDocument()
    await expect(message).toHaveValue("")
    await userEvent.type(message, "A fresh conversation")
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(
        canvas.getByText(
          "This is a demo reply. In the app, your applied agent answers here."
        )
      ).toBeVisible()
    )
    // Finish the visible message transition before the automatic contrast scan.
    await waitFor(() =>
      expect(
        canvas.getByRole("article", { name: "Assistant message" })
      ).toHaveStyle({ opacity: "1" })
    )
  },
}

export const Configuration: Story = {
  parameters: { msw: { handlers: handlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const replies = await canvas.findByRole("switch", { name: "Agent replies" })
    await expect(replies).toBeChecked()
    await userEvent.click(replies)
    await waitFor(() => expect(replies).not.toBeChecked())
    await expect(
      canvas.getByText("Paused. Turn on to resume automatic replies.")
    ).toBeVisible()
    await userEvent.click(replies)
    await waitFor(() => expect(replies).toBeChecked())
    await userEvent.click(
      canvas.getByRole("button", { name: "Connection actions" })
    )
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Check connection" })
    )
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Meta authorization is working."
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Connection actions" })
    )
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Disconnect" })
    )
    await expect(
      await page.findByRole("dialog", { name: "Disconnect WhatsApp?" })
    ).toBeVisible()
    await userEvent.click(page.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await expect(replies).toBeChecked()
  },
}

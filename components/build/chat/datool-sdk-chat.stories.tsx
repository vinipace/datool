import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { DatoolChat, type ChatMessage } from "@/packages/react/src/index"
import "@/packages/react/src/styles.css"

let messages: ChatMessage[] = []
let authorized = true
const message = (
  text: string,
  role: "user" | "assistant" = "assistant"
): ChatMessage => ({
  id: crypto.randomUUID(),
  text,
  role,
  createdAt: new Date().toISOString(),
})
const meta = {
  title: "Build/DatoolSdkChat",
  component: DatoolChat,
  args: { endpoint: "/sdk-chat-fixture", pollingInterval: 1000 },
  beforeEach: () => {
    messages = []
    authorized = true
  },
  parameters: {
    layout: "centered",
    msw: {
      handlers: [
        http.post("*/sdk-chat-fixture", async ({ request }) => {
          if (!authorized)
            return HttpResponse.json(
              { error: { message: "Session expired" } },
              { status: 401 }
            )
          const body = (await request.json()) as {
            action: string
            text?: string
          }
          if (body.action === "session")
            return HttpResponse.json({ data: { conversationId: "chat" } })
          if (body.action === "send") {
            messages.push(
              message(body.text!, "user"),
              message("I can help with that.")
            )
            return HttpResponse.json({
              data: {
                conversationId: "chat",
                status: "completed",
                text: "I can help with that.",
              },
            })
          }
          return HttpResponse.json({
            data: {
              conversationId: "chat",
              messages,
              pending: false,
              failed: false,
              nextCursor: null,
            },
          })
        }),
      ],
    },
  },
  decorators: [
    (Story) => (
      <div className="w-80 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DatoolChat>
export default meta
type Story = StoryObj<typeof meta>
export const ConversationAndProactiveReply: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    await waitFor(() => expect(input).toBeEnabled())
    await userEvent.type(input, "Review my files{enter}")
    await expect(
      canvas.findByText("I can help with that.")
    ).resolves.toBeVisible()
    await expect(canvas.getByText("Review my files")).toBeVisible()
    messages.push(message("Your scheduled briefing is ready."))
    await waitFor(
      () =>
        expect(
          canvas.getByText("Your scheduled briefing is ready.")
        ).toBeVisible(),
      { timeout: 5000 }
    )
  },
}
export const IdentityChangesClearHistory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    messages.push(message("Private organization context"))
    await expect(
      canvas.findByText("Private organization context")
    ).resolves.toBeVisible()
    authorized = false
    await waitFor(
      () =>
        expect(canvas.getByRole("button", { name: "Reconnect" })).toBeVisible(),
      { timeout: 5000 }
    )
    await expect(
      canvas.queryByText("Private organization context")
    ).not.toBeInTheDocument()
    messages = []
    authorized = true
    await userEvent.click(canvas.getByRole("button", { name: "Reconnect" }))
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Message" })).toBeEnabled()
    )
  },
}

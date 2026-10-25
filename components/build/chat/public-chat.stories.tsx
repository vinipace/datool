import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import { PublicChat } from "./public-chat"

const channelId = "startup-test"
const key = `datool:public-chat:${channelId}:same-origin:session`
const appearance = chatBubbleSettingsSchema.parse({
  displayName: "Store assistant",
  welcomeMessage: "How can I help?",
  theme: "light",
})
const session = {
  conversationId: "conversation-startup",
  visitorToken: `${btoa(JSON.stringify({ expiresAt: 4102444800 }))}.test-signature`,
  visitorId: "test-visitor",
  appearance,
}
let releaseSession: () => void
let sessionGate: Promise<void>
let releaseMessages: () => void
let messagesGate: Promise<void>
let releaseHistory: () => void
let historyGate: Promise<void>
let sessionAppearance = appearance
let restored = false
let failSession = false
let submitted: unknown[] = []
let sessionRequests = 0
let messageRequests = 0
let hostRequests = 0
let shopifyHost = false

const meta = {
  title: "Build/PublicChat",
  component: PublicChat,
  args: { channelId, initialAppearance: appearance, embedded: true },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.post(`/api/build-public/${channelId}/session`, async () => {
          sessionRequests++
          await sessionGate
          return failSession
            ? HttpResponse.json(
                { error: { message: "Chat unavailable" } },
                { status: 503 }
              )
            : HttpResponse.json({
                data: { ...session, appearance: sessionAppearance },
              })
        }),
        http.get(`/api/build-public/${channelId}/session`, async () => {
          await historyGate
          return HttpResponse.json({ data: [] })
        }),
        // Appearance is already supplied by the page/session. A redundant read
        // must not hold the composer hostage when this endpoint is unavailable.
        http.get(`/api/build-public/${channelId}/appearance`, () =>
          HttpResponse.json({}, { status: 503 })
        ),
        http.get(
          `/api/build-public/${channelId}/conversation/:id`,
          async () => {
            messageRequests++
            await messagesGate
            return HttpResponse.json({
              data: restored
                ? [
                    ...Array.from({ length: 24 }, (_, index) => ({
                      id: `older-${index}`,
                      direction: "outbound",
                      text: `Earlier answer ${index + 1}`,
                    })),
                    {
                      id: "previous-message",
                      direction: "inbound",
                      text: "Previous question",
                      pendingReply: true,
                    },
                  ]
                : [],
            })
          }
        ),
        http.post(
          `/api/build-public/${channelId}/conversation/:id`,
          async ({ request }) => {
            submitted.push(await request.json())
            return HttpResponse.json({ data: {} })
          }
        ),
      ],
    },
  },
  beforeEach: () => {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const item of Object.keys(storage)) {
        if (item.startsWith(`datool:public-chat:${channelId}:`))
          storage.removeItem(item)
      }
    }
    // Exercise the iframe client with the same source/origin as a real host.
    // Dispatch from the parent so the browser supplies the authentic source.
    const reply = (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.data?.type !== "datool:chat:session-request"
      )
        return
      hostRequests++
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window.parent,
          origin: window.location.origin,
          data: {
            type: "datool:chat:session-response",
            requestId: event.data.requestId,
            shopify: shopifyHost,
            ...(shopifyHost ? { session } : {}),
          },
        })
      )
    }
    window.parent.addEventListener("message", reply)
    window.sessionStorage.removeItem(key)
    window.localStorage.removeItem(key)
    restored = false
    sessionAppearance = appearance
    failSession = false
    submitted = []
    sessionRequests = 0
    messageRequests = 0
    hostRequests = 0
    shopifyHost = false
    sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve
    })
    messagesGate = new Promise<void>((resolve) => {
      releaseMessages = resolve
    })
    historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve
    })
    return () => {
      window.parent.removeEventListener("message", reply)
      window.localStorage.removeItem(key)
      window.localStorage.removeItem(
        `datool:public-chat:${channelId}:${window.location.origin}:session`
      )
      releaseSession()
      releaseMessages()
      releaseHistory()
      window.sessionStorage.removeItem(key)
      window.sessionStorage.removeItem(
        `datool:public-chat:${channelId}:${window.location.origin}:session`
      )
    }
  },
} satisfies Meta<typeof PublicChat>
export default meta
type Story = StoryObj<typeof meta>

export const PreloadedIframe: Story = {
  args: { deferSessionUntilOpen: true },
  render: (args) => (
    <PublicChat {...args} embedOrigin={window.location.origin} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const visibility = (
      visible: boolean,
      origin = window.location.origin,
      source = window.parent
    ) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          origin,
          data: { type: "datool:chat:visibility", visible },
        })
      )
    }
    const nextFrame = () => new Promise(requestAnimationFrame)
    await nextFrame()
    await expect(sessionRequests).toBe(0)
    await expect(hostRequests).toBe(0)
    visibility(true, "https://unrelated.test")
    visibility(true, window.location.origin, window)
    await nextFrame()
    await expect(sessionRequests).toBe(0)
    await expect(hostRequests).toBe(0)
    visibility(true)
    releaseSession()
    releaseMessages()
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Keep this draft"
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Send message" })).toBeEnabled()
    )
    await waitFor(() => expect(messageRequests).toBeGreaterThan(0), {
      timeout: 2500,
    })
    visibility(false)
    await nextFrame()
    const closedReads = messageRequests
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(messageRequests).toBe(closedReads)
    visibility(true)
    await waitFor(() => expect(messageRequests).toBeGreaterThan(closedReads), {
      timeout: 2500,
    })
    await expect(sessionRequests).toBe(shopifyHost ? 0 : 1)
    await expect(hostRequests).toBe(shopifyHost ? 2 : 1)
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep this draft"
    )
  },
}

export const ShopifyPreloadedIframe: Story = {
  ...PreloadedIframe,
  args: { deferSessionUntilOpen: true, shopifyIdentity: true },
  beforeEach: () => {
    shopifyHost = true
  },
}

export const SlowConnection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await expect(input).toBeEnabled()
    await userEvent.type(input, "Do you have this in blue?")
    await userEvent.keyboard("{Enter}")
    await expect(send).toBeDisabled()
    await expect(submitted).toEqual([])
    releaseSession()
    // Neither an appearance request nor an empty-message read is needed.
    await waitFor(() => expect(send).toBeEnabled())
    await expect(input).toHaveValue("Do you have this in blue?")
    await userEvent.click(send)
    await waitFor(() => expect(submitted).toHaveLength(1))
    await expect(submitted[0]).toMatchObject({
      text: "Do you have this in blue?",
    })
    releaseMessages()
  },
}

export const RestoringConversation: Story = {
  beforeEach: () => {
    restored = true
    releaseSession()
    window.sessionStorage.setItem(key, JSON.stringify(session))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await userEvent.type(input, "And the size?")
    await expect(send).toBeDisabled()
    releaseMessages()
    await expect(await canvas.findByText("Previous question")).toBeVisible()
    await waitFor(() => {
      const log = canvas.getByRole("log")
      expect(log.scrollTop).toBeGreaterThan(0)
      expect(
        canvas.getByText("Previous question").getBoundingClientRect().bottom
      ).toBeLessThanOrEqual(log.getBoundingClientRect().bottom)
    })
    await expect(input).toHaveValue("And the size?")
    // Restoring a pending agent reply must not enable a duplicate turn.
    await expect(input).toHaveAttribute("readonly")
    await expect(send).toBeDisabled()
    await expect(submitted).toEqual([])
  },
}

export const SlowHistory: Story = {
  args: {
    initialAppearance: chatBubbleSettingsSchema.parse({
      ...appearance,
      layout: "help_page",
    }),
  },
  beforeEach: () => {
    sessionAppearance = chatBubbleSettingsSchema.parse({
      ...appearance,
      layout: "help_page",
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    releaseSession()
    const input = await canvas.findByRole("textbox", { name: "Message" })
    await userEvent.type(input, "Help me choose")
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeEnabled()
    releaseHistory()
  },
}

export const ConnectionFailure: Story = {
  beforeEach: () => {
    failSession = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Keep my draft"
    )
    releaseSession()
    await expect(await canvas.findByRole("alert")).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Send message" })
    ).not.toBeInTheDocument()
    failSession = false
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Send message" })).toBeEnabled()
    )
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep my draft"
    )
  },
}

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
let hostSession = session
let hostGate = Promise.resolve()
let releaseHost = () => {}
let failHost = false
let conversationMessages: Array<{
  id: string
  direction: string
  text: string
}> = []

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
                : conversationMessages,
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
    let active = true
    const reply = async (event: MessageEvent) => {
      if (
        event.source !== window ||
        event.data?.type !== "datool:chat:session-request"
      )
        return
      hostRequests++
      await hostGate
      if (!active) return
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window.parent,
          origin: window.location.origin,
          data: {
            type: "datool:chat:session-response",
            requestId: event.data.requestId,
            shopify: shopifyHost,
            ...(failHost
              ? { error: { message: "Store verification unavailable" } }
              : shopifyHost
                ? { session: hostSession }
                : {}),
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
    hostSession = session
    hostGate = Promise.resolve()
    releaseHost = () => {}
    failHost = false
    conversationMessages = []
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
      active = false
      window.parent.removeEventListener("message", reply)
      window.localStorage.removeItem(key)
      window.localStorage.removeItem(
        `datool:public-chat:${channelId}:${window.location.origin}:session`
      )
      releaseHost()
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
  args: { preloaded: true },
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
    conversationMessages = [
      {
        id: "ready-history",
        direction: "outbound",
        text: "Your conversation is ready",
      },
    ]
    await expect(
      canvas.queryByText("Loading conversation…")
    ).not.toBeInTheDocument()
    await nextFrame()
    await waitFor(() => expect(hostRequests).toBe(1))
    await waitFor(() => expect(sessionRequests).toBe(shopifyHost ? 0 : 1))
    visibility(true, "https://unrelated.test")
    visibility(true, window.location.origin, window)
    await nextFrame()
    await expect(sessionRequests).toBe(shopifyHost ? 0 : 1)
    await expect(hostRequests).toBe(1)
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
    await expect(
      await within(canvas.getByRole("log")).findByText(
        "Your conversation is ready"
      )
    ).toBeVisible()
    visibility(false)
    await nextFrame()
    const closedReads = messageRequests
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(messageRequests).toBe(closedReads)
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    visibility(true)
    await nextFrame()
    await expect(
      within(canvas.getByRole("log")).getByText("Your conversation is ready")
    ).toBeVisible()
    await expect(
      canvas.queryByText("Loading conversation…")
    ).not.toBeInTheDocument()
    releaseHost()
    await waitFor(() => expect(messageRequests).toBeGreaterThan(closedReads), {
      timeout: 2500,
    })
    await expect(sessionRequests).toBe(shopifyHost ? 0 : 1)
    await expect(hostRequests).toBeGreaterThanOrEqual(shopifyHost ? 2 : 1)
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep this draft"
    )
    if (shopifyHost) {
      visibility(false)
      await nextFrame()
      const descriptor = Object.getOwnPropertyDescriptor(
        document,
        "visibilityState"
      )
      try {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        })
        document.dispatchEvent(new Event("visibilitychange"))
        await waitFor(() =>
          expect(
            within(canvas.getByRole("log")).queryByText(
              "Your conversation is ready"
            )
          ).not.toBeInTheDocument()
        )
        hostSession = {
          ...session,
          visitorId: "changed-visitor",
          conversationId: "changed-conversation",
        }
        conversationMessages = []
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        })
        document.dispatchEvent(new Event("visibilitychange"))
        await waitFor(() =>
          expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
            ""
          )
        )
        visibility(true)
        await expect(
          within(canvas.getByRole("log")).queryByText(
            "Your conversation is ready"
          )
        ).not.toBeInTheDocument()
      } finally {
        if (descriptor)
          Object.defineProperty(document, "visibilityState", descriptor)
        else Reflect.deleteProperty(document, "visibilityState")
      }
    }
  },
}

export const ShopifyPreloadedIframe: Story = {
  ...PreloadedIframe,
  args: { preloaded: true, shopifyIdentity: true },
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

// This boundary owns the real host verification -> optimistic UI -> HTTP send
// lifecycle. Hold the host reply to expose any UI blocked on the round trip.
export const ShopifySendWhileVerifying: Story = {
  args: { shopifyIdentity: true },
  render: (args) => (
    <PublicChat {...args} embedOrigin={window.location.origin} />
  ),
  beforeEach: () => {
    shopifyHost = true
    releaseMessages()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await userEvent.type(input, "Do you have this in blue?")
    await waitFor(() => expect(send).toBeEnabled())
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    await userEvent.click(send)
    await waitFor(() => expect(hostRequests).toBeGreaterThanOrEqual(2))
    await expect(
      await within(canvas.getByRole("log")).findByText(
        "Do you have this in blue?"
      )
    ).toBeVisible()
    await expect(input).toHaveValue("")
    await expect(
      canvas.queryByText("Loading conversation…")
    ).not.toBeInTheDocument()
    await expect(submitted).toEqual([])
    // A focus refresh must not erase the optimistic message or invalidate send.
    window.dispatchEvent(new Event("focus"))
    conversationMessages = [
      {
        id: "sent-message",
        direction: "inbound",
        text: "Do you have this in blue?",
      },
    ]
    releaseHost()
    await waitFor(() => expect(submitted).toHaveLength(1))
    await waitFor(() =>
      expect(
        within(canvas.getByRole("log")).getAllByText(
          "Do you have this in blue?"
        )
      ).toHaveLength(1)
    )
  },
}

export const ShopifyChangedIdentityBeforeSend: Story = {
  ...ShopifySendWhileVerifying,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await userEvent.type(input, "Keep this unsent question")
    await waitFor(() => expect(send).toBeEnabled())
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    await userEvent.click(send)
    await expect(
      await within(canvas.getByRole("log")).findByText(
        "Keep this unsent question"
      )
    ).toBeVisible()
    hostSession = {
      ...session,
      visitorId: "another-visitor",
      conversationId: "another-conversation",
    }
    releaseHost()
    await expect(
      await canvas.findByText(
        "Your store session changed. Please review the chat before sending."
      )
    ).toBeVisible()
    await expect(submitted).toEqual([])
    await expect(input).toHaveValue("Keep this unsent question")
    await expect(
      within(canvas.getByRole("log")).queryByText("Keep this unsent question")
    ).not.toBeInTheDocument()
  },
}

export const ShopifyVerificationFailure: Story = {
  ...ShopifySendWhileVerifying,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await userEvent.type(input, "Keep this failed question")
    await waitFor(() => expect(send).toBeEnabled())
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    await userEvent.click(send)
    await expect(
      await within(canvas.getByRole("log")).findByText(
        "Keep this failed question"
      )
    ).toBeVisible()
    failHost = true
    releaseHost()
    await expect(await canvas.findByRole("alert")).toBeVisible()
    await expect(submitted).toEqual([])
    failHost = false
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
        "Keep this failed question"
      )
    )
  },
}

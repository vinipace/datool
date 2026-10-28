import { BubblePreview } from "./bubble-preview"
import * as React from "react"
import { Button } from "@/components/ui/button"
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
let rejectSend = false
let sendGate = Promise.resolve()
let releaseSend = () => {}
let conversationMessages: Array<{
  id: string
  direction: string
  text: string
  pendingReply?: boolean
  providerMessageId?: string
}> = []

const meta = {
  title: "Build/PublicChat",
  component: PublicChat,
  args: { channelId, initialAppearance: appearance, embedded: true },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.post("/api/build/build_create_conversation", () =>
          HttpResponse.json({ data: { id: session.conversationId } })
        ),
        http.post("/api/build/build_list_conversation_messages", async () => {
          messageRequests++
          await messagesGate
          return HttpResponse.json({
            data: {
              items: conversationMessages.map((message) => ({
                id: message.id,
                role: message.direction === "inbound" ? "user" : "assistant",
                content: message.text,
                metadata: {
                  clientMessageId: message.providerMessageId?.slice(
                    session.visitorId.length + 1
                  ),
                },
              })),
            },
          })
        }),
        http.post("/api/build/build_run_agent_turn", async ({ request }) => {
          const body = (await request.json()) as { message: string }
          submitted.push({
            text: body.message,
            idempotencyKey: request.headers.get("idempotency-key"),
          })
          await sendGate
          return rejectSend
            ? HttpResponse.json(
                { error: { message: "Temporarily unavailable" } },
                { status: 503 }
              )
            : HttpResponse.json({ data: {} })
        }),
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
            await sendGate
            if (rejectSend)
              return HttpResponse.json(
                { error: { message: "Temporarily unavailable" } },
                { status: 503 }
              )
            return HttpResponse.json({ data: {} })
          }
        ),
      ],
    },
  },
  afterEach: async ({ canvasElement }) => {
    await waitFor(() => {
      for (const message of canvasElement.querySelectorAll(
        "[data-chat-message]"
      ))
        expect(getComputedStyle(message).opacity).toBe("1")
    })
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
    rejectSend = false
    sendGate = Promise.resolve()
    releaseSend = () => {}
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
      releaseSend()
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
        const transcript = canvas.getByRole("log")
        const bubble = within(transcript)
          .getByText("Your conversation is ready")
          .closest("article")!
        const setVisibility = (value: "hidden" | "visible") => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value,
          })
          document.dispatchEvent(new Event("visibilitychange"))
        }
        hostGate = new Promise<void>((resolve) => {
          releaseHost = resolve
        })
        messagesGate = new Promise<void>((resolve) => {
          releaseMessages = resolve
        })
        const previousHostRequests = hostRequests
        const previousMessageRequests = messageRequests
        setVisibility("hidden")
        await nextFrame()
        setVisibility("visible")
        window.dispatchEvent(new Event("focus"))
        await waitFor(() =>
          expect(hostRequests).toBeGreaterThan(previousHostRequests)
        )
        // Returning to a tab preserves the existing bubbles while both signed
        // identity verification and the subsequent history refresh are pending.
        await expect(bubble).toBeInTheDocument()
        await expect(bubble).toBeVisible()
        await expect(
          canvas.getByRole("textbox", { name: "Message" })
        ).toHaveValue("Keep this draft")
        releaseHost()
        await waitFor(() =>
          expect(messageRequests).toBeGreaterThan(previousMessageRequests)
        )
        await expect(bubble).toBeInTheDocument()
        releaseMessages()
        await nextFrame()
        await expect(bubble).toBeInTheDocument()
        // If revalidation fails, the previously visible private transcript must
        // disappear. A later successful check can recover the same conversation.
        failHost = true
        setVisibility("hidden")
        await nextFrame()
        setVisibility("visible")
        await waitFor(() =>
          expect(canvas.getByText("Couldn't load the chat")).toBeVisible()
        )
        await expect(
          within(transcript).queryByText("Your conversation is ready")
        ).not.toBeInTheDocument()
        failHost = false
        document.dispatchEvent(new Event("visibilitychange"))
        await expect(
          await within(transcript).findByText("Your conversation is ready")
        ).toBeVisible()
        setVisibility("hidden")
        await nextFrame()
        messagesGate = new Promise<void>((resolve) => {
          releaseMessages = resolve
        })
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
        releaseMessages()
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
    await userEvent.type(input, " In medium.")
    await expect(input).toHaveValue("And the size? In medium.")
    await userEvent.keyboard("{Enter}")
    await expect(send).toBeDisabled()
    await expect(submitted).toEqual([])
    restored = false
    conversationMessages = [
      {
        id: "previous-message",
        direction: "inbound",
        text: "Previous question",
      },
      { id: "reply", direction: "outbound", text: "Medium is available." },
    ]
    await waitFor(() => expect(send).toBeEnabled(), { timeout: 2500 })
    await expect(input).toHaveValue("And the size? In medium.")
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

// The browser boundary owns delivery recovery: preserve the bubble and the next
// draft, retry the original text with the same server key, and lock double clicks.
export const FailedMessageRetry: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    releaseSession()
    releaseMessages()
    const input = canvas.getByRole("textbox", { name: "Message" })
    const send = canvas.getByRole("button", { name: "Send message" })
    await userEvent.type(input, "Please check medium")
    await waitFor(() => expect(send).toBeEnabled())
    sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    rejectSend = true
    await userEvent.click(send)
    await waitFor(() => expect(submitted).toHaveLength(1))
    await userEvent.type(input, "My next question")
    releaseSend()
    const retry = await canvas.findByRole("button", { name: "Retry sending" })
    await expect(
      within(canvas.getByRole("log")).getByText("Please check medium")
    ).toBeVisible()
    await expect(input).toHaveValue("My next question")
    if (!args.previewAgentId) {
      const readsBefore = messageRequests
      await waitFor(
        () => expect(messageRequests).toBeGreaterThan(readsBefore),
        {
          timeout: 2500,
        }
      )
    }
    await expect(retry).toBeVisible()
    sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    rejectSend = false
    await userEvent.dblClick(retry)
    await waitFor(() => expect(submitted).toHaveLength(2))
    const first = submitted[0] as { text: string; idempotencyKey: string }
    const second = submitted[1] as { text: string; idempotencyKey: string }
    await expect(first.idempotencyKey).toEqual(expect.any(String))
    await expect(first.idempotencyKey.length).toBeGreaterThan(0)
    await expect(second).toMatchObject({
      text: "Please check medium",
      idempotencyKey: first.idempotencyKey,
    })
    await expect(send).toBeDisabled()
    await userEvent.type(input, " with more detail")
    conversationMessages = [
      {
        id: "accepted-message",
        direction: "inbound",
        text: first.text,
        providerMessageId: `${session.visitorId}:${first.idempotencyKey}`,
      },
    ]
    const bubble = canvas.getByRole("article", { name: "Your message" })
    await waitFor(() => expect(getComputedStyle(bubble).opacity).toBe("1"))
    releaseSend()
    await waitFor(() => expect(send).toBeEnabled())
    // Acknowledgement must update the existing bubble without replaying entry.
    await expect(canvas.getByRole("article", { name: "Your message" })).toBe(
      bubble
    )
    await expect(getComputedStyle(bubble).opacity).toBe("1")
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: "Retry sending" })
      ).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(
        within(canvas.getByRole("log")).getAllByText(first.text)
      ).toHaveLength(1)
    )
    await expect(input).toHaveValue("My next question with more detail")
    await expect(submitted).toHaveLength(2)
  },
}

export const LostAcknowledgement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    releaseSession()
    releaseMessages()
    rejectSend = true
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Did this arrive?"
    )
    const send = canvas.getByRole("button", { name: "Send message" })
    await waitFor(() => expect(send).toBeEnabled())
    await userEvent.click(send)
    await canvas.findByRole("button", { name: "Retry sending" })
    const request = submitted[0] as { idempotencyKey: string }
    // The next real history response proves the original request was accepted.
    conversationMessages = [
      {
        id: "durable-message",
        direction: "inbound",
        text: "Did this arrive?",
        providerMessageId: `${session.visitorId}:${request.idempotencyKey}`,
      },
    ]
    await waitFor(
      () =>
        expect(
          canvas.queryByRole("button", { name: "Retry sending" })
        ).not.toBeInTheDocument(),
      { timeout: 2500 }
    )
    await waitFor(() =>
      expect(
        within(canvas.getByRole("log")).getAllByText("Did this arrive?")
      ).toHaveLength(1)
    )
    await expect(submitted).toHaveLength(1)
  },
}

export const ReadingEarlierMessages: Story = {
  beforeEach: () => {
    window.sessionStorage.setItem(key, JSON.stringify(session))
    conversationMessages = Array.from({ length: 30 }, (_, index) => ({
      id: `answer-${index}`,
      direction: "outbound",
      text: `Earlier answer ${index + 1}: Here are the available sizes and colors.`,
    }))
    releaseSession()
    releaseMessages()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("log")
    await within(log).findByText(/Earlier answer 30:/)
    await waitFor(() => expect(log.scrollTop).toBeGreaterThan(0))
    log.scrollTo({ top: 0, behavior: "instant" })
    await waitFor(() => expect(log.scrollTop).toBe(0))
    // Let the browser dispatch the user's scroll before the next server response.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    conversationMessages.push({
      id: "new-answer",
      direction: "outbound",
      text: "Your size is now in stock.",
    })
    await within(log).findByText(
      "Your size is now in stock.",
      {},
      { timeout: 2500 }
    )
    await expect(log.scrollTop).toBe(0)
    const jump = await canvas.findByRole(
      "button",
      { name: "New message" },
      { timeout: 2500 }
    )
    await expect(log.scrollTop).toBe(0)
    await userEvent.click(jump)
    await waitFor(() =>
      expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(
        64
      )
    )
    await expect(
      canvas.queryByRole("button", { name: "New message" })
    ).not.toBeInTheDocument()
    conversationMessages.push({
      id: "another-answer",
      direction: "outbound",
      text: "Shipping is available too.",
    })
    await within(log).findByText(
      "Shipping is available too.",
      {},
      { timeout: 2500 }
    )
    await waitFor(() =>
      expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(
        64
      )
    )
    await expect(
      canvas.queryByRole("button", { name: "New message" })
    ).not.toBeInTheDocument()
  },
}

// Preview uses the authenticated operation transport. Its retry key must travel
// in the actual idempotency header, not just the operation's JSON input.
export const PreviewFailedMessageRetry: Story = {
  ...FailedMessageRetry,
  args: { previewAgentId: "preview-agent" },
  render: (args) => (
    <div className="h-dvh">
      <PublicChat {...args} />
    </div>
  ),
}

// A real remount models a storefront page navigation. Cache contents must come
// from the first verified chat and remain private until the next host check.
export const ShopifyPageNavigation: Story = {
  args: { shopifyIdentity: true },
  beforeEach: () => {
    shopifyHost = true
  },
  render: function PageNavigation(args) {
    const [page, setPage] = React.useState(0)
    return (
      <div className="h-[42rem] max-w-md">
        <Button onClick={() => setPage((value) => value + 1)}>
          Navigate to another store page
        </Button>
        <PublicChat {...args} key={page} embedOrigin={window.location.origin} />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    conversationMessages = [
      {
        id: "saved-reply",
        direction: "outbound",
        text: "The medium snowboard is available.",
      },
    ]
    releaseMessages()
    await expect(
      await canvas.findByText("The medium snowboard is available.")
    ).toBeVisible()
    messagesGate = new Promise<void>((resolve) => {
      releaseMessages = resolve
    })
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Navigate to another store page" })
    )
    await expect(
      canvas.queryByText(appearance.welcomeMessage)
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("The medium snowboard is available.")
    ).not.toBeInTheDocument()
    releaseHost()
    // The verified snapshot is visible even though the history request is held.
    await expect(
      await canvas.findByText("The medium snowboard is available.")
    ).toBeVisible()
    await expect(
      canvas.queryByText(appearance.welcomeMessage)
    ).not.toBeInTheDocument()
    conversationMessages = [
      ...conversationMessages,
      {
        id: "new-reply",
        direction: "outbound",
        text: "Your conversation is up to date.",
      },
    ]
    releaseMessages()
    await waitFor(() =>
      expect(canvas.getByText("Your conversation is up to date.")).toBeVisible()
    )
    // A different signed visitor must never inherit the prior page's snapshot.
    hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve
    })
    messagesGate = new Promise<void>((resolve) => {
      releaseMessages = resolve
    })
    hostSession = {
      ...session,
      visitorId: "another-visitor",
      conversationId: "another-conversation",
    }
    conversationMessages = []
    await userEvent.click(
      canvas.getByRole("button", { name: "Navigate to another store page" })
    )
    releaseHost()
    const before = messageRequests
    await waitFor(() => expect(messageRequests).toBeGreaterThan(before))
    await expect(
      canvas.queryByText("The medium snowboard is available.")
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("Your conversation is up to date.")
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByText(appearance.welcomeMessage)
    ).not.toBeInTheDocument()
    releaseMessages()
    await expect(
      await canvas.findByText(appearance.welcomeMessage)
    ).toBeVisible()
  },
}

export const CountryWelcome: Story = {
  args: {
    visitorCountry: "BR",
    initialBrowserLanguages: "en-US",
    initialAppearance: chatBubbleSettingsSchema.parse({
      ...appearance,
      displayName: "Datool",
      welcomeMessage:
        "Hi! I’m Datool’s AI assistant. What would you like to improve: customer conversations or your AI app?",
      suggestedReplies: ["See pricing", "Request a demo"],
      localization: {
        source: "country",
        defaultLanguage: "en",
        languages: ["en", "pt-BR"],
        translations: {
          "pt-BR": {
            welcomeMessage:
              "Olá! Sou o assistente de IA da Datool. O que você quer melhorar: o atendimento aos clientes ou seu aplicativo de IA?",
            inputPlaceholder: "Pergunte sobre a Datool…",
            suggestedReplies: [
              "Quero vender pelo meu site",
              "Melhorar meu aplicativo de IA",
              "Ver preços",
              "Solicitar uma demonstração",
            ],
          },
        },
      },
    }),
  },
  beforeEach: ({ args }) => {
    sessionAppearance = args.initialAppearance!
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Controls localize before the session finishes, then welcome/suggestions
    // remain localized when the returned appearance replaces the initial one.
    await expect(
      canvas.getByPlaceholderText("Pergunte sobre a Datool…")
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "See pricing" })
    ).not.toBeInTheDocument()
    releaseSession()
    releaseHistory()
    await expect(
      await canvas.findByText(/^Olá! Sou o assistente/)
    ).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("button", { name: "Ver preços" })
    )
    await waitFor(() => expect(submitted).toHaveLength(1))
    await expect(submitted[0]).toMatchObject({ text: "Ver preços" })
  },
}

export const CountryPreview: Story = {
  args: CountryWelcome.args,
  parameters: {
    msw: {
      handlers: [
        http.post("/api/build/build_create_conversation", () =>
          HttpResponse.json({ data: { id: "country-preview" } })
        ),
        http.post("/api/build/build_list_conversation_messages", () =>
          HttpResponse.json({ data: { items: [] } })
        ),
      ],
    },
  },
  render: (args) => (
    <div className="h-dvh">
      <BubblePreview
        settings={args.initialAppearance!}
        channelId="country-preview"
        agentId="country-preview"
        onBeforeSend={async () => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const country = canvas.getByRole("combobox", {
      name: "Preview visitor country",
    })
    await expect(
      await canvas.findByRole("button", { name: "Ver preços" })
    ).toBeVisible()
    await userEvent.selectOptions(country, "US")
    await expect(
      canvas.getByRole("button", { name: "See pricing" })
    ).toBeVisible()
    await expect(
      canvas.queryByText(/^Olá! Sou o assistente/)
    ).not.toBeInTheDocument()
    await userEvent.selectOptions(country, "BR")
    await userEvent.click(
      canvas.getByRole("button", { name: "Mobile preview" })
    )
    await expect(
      canvas.getByRole("button", { name: "Ver preços" })
    ).toBeVisible()
    await expect(canvas.getByText(/^Olá! Sou o assistente/)).toBeVisible()
  },
}

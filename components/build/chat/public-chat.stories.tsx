import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import { PublicChat } from "./public-chat"
import { BubblePreview } from "./bubble-preview"

const channelId = "startup-test"
const key = `datool:public-chat:${channelId}:same-origin:session`
const appearance = chatBubbleSettingsSchema.parse({
  displayName: "Store assistant",
  welcomeMessage: "How can I help?",
  theme: "light",
})
const session = {
  conversationId: "conversation-startup",
  visitorToken: "test-visitor-token",
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
    window.sessionStorage.removeItem(key)
    restored = false
    sessionAppearance = appearance
    failSession = false
    submitted = []
    sessionRequests = 0
    messageRequests = 0
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
    visibility(true, "https://unrelated.test")
    visibility(true, window.location.origin, window)
    await nextFrame()
    await expect(sessionRequests).toBe(0)
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
    await expect(sessionRequests).toBe(1)
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep this draft"
    )
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

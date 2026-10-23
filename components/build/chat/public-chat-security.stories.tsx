import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { http, HttpResponse } from "msw"
import { Button } from "@/components/ui/button"
import { PublicChat } from "./public-chat"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import { ShopifyChatSetup } from "../agents/shopify-chat-setup"

const channelId = "11111111-1111-4111-8111-111111111111"
const appearance = chatBubbleSettingsSchema.parse({
  displayName: "Store assistant",
})
const handlers = [
  http.get("*/api/build-public/:channel/appearance", () =>
    HttpResponse.json({ data: { appearance } })
  ),
  http.get(
    "*/api/build-public/:channel/conversation/:conversation",
    ({ params }) =>
      HttpResponse.json({
        data: [
          {
            id: "reply",
            direction: "outbound",
            text:
              params.conversation === "customer-a"
                ? "Private question from customer A"
                : "Welcome, guest",
          },
        ],
      })
  ),
]
const meta = {
  title: "Build/StoreChatSecurity",
  component: PublicChat,
  args: { channelId },
  parameters: { msw: { handlers } },
} satisfies Meta<typeof PublicChat>
export default meta
type Story = StoryObj<typeof meta>

function StoreSessionFixture() {
  const [customer, setCustomer] = React.useState("customer-a")
  React.useLayoutEffect(() => {
    // Simulate the host's verified response at the browser message boundary.
    const original = window.parent.postMessage
    window.parent.postMessage = ((data: {
      type?: string
      requestId?: string
    }) => {
      if (data?.type !== "datool:chat:session-request") return
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window.parent,
            origin: location.origin,
            data: {
              type: "datool:chat:session-response",
              requestId: data.requestId,
              shopify: true,
              session: {
                conversationId: customer,
                visitorId: customer,
                visitorToken: "fixture-access",
              },
            },
          })
        )
      )
    }) as typeof window.parent.postMessage
    return () => {
      window.parent.postMessage = original
    }
  }, [customer])
  React.useEffect(() => {
    if (customer === "guest") window.dispatchEvent(new Event("focus"))
  }, [customer])
  return (
    <div className="h-[42rem] max-w-md">
      <Button onClick={() => setCustomer("guest")}>
        Simulate Shopify logout
      </Button>
      <PublicChat
        channelId={channelId}
        embedded
        shopifyIdentity
        embedOrigin={location.origin}
      />
    </div>
  )
}
export const AccountSwitch: Story = {
  render: () => <StoreSessionFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Private question from customer A")).toBeVisible()
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Simulate Shopify logout" })
    )
    await waitFor(() =>
      expect(canvas.getByText("Welcome, guest")).toBeVisible()
    )
    await waitFor(() =>
      expect(
        getComputedStyle(canvas.getByText("Welcome, guest").closest("article")!)
          .opacity
      ).toBe("1")
    )
    await expect(
      canvas.queryByText("Private question from customer A")
    ).not.toBeInTheDocument()
  },
}
export const Challenge: Story = {
  parameters: {
    msw: {
      handlers: [
        ...handlers,
        http.post(
          "*/api/build-public/:channel/session",
          async ({ request }) => {
            const body = (await request.json()) as { challengeToken?: string }
            return body.challengeToken === "verified-fixture"
              ? HttpResponse.json({
                  data: {
                    conversationId: "guest",
                    visitorId: "guest",
                    visitorToken: "fixture",
                  },
                })
              : HttpResponse.json(
                  {
                    error: {
                      code: "PUBLIC_CHALLENGE_REQUIRED",
                      siteKey: "fixture",
                      connectionId: channelId,
                    },
                  },
                  { status: 403 }
                )
          }
        ),
      ],
    },
  },
  beforeEach: () => {
    localStorage.removeItem(
      `datool:public-chat:${channelId}:same-origin:session`
    )
    sessionStorage.clear()
    const host = window as Window & { turnstile?: unknown }
    const previous = host.turnstile
    host.turnstile = {
      render: (
        node: HTMLElement,
        options: { callback: (token: string) => void }
      ) => {
        const button = document.createElement("button")
        button.textContent = "Verify test visitor"
        button.onclick = () => options.callback("verified-fixture")
        node.append(button)
        return "fixture"
      },
      remove: () => {},
    }
    return () => {
      host.turnstile = previous
    }
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const dialog = within(
      await page.findByRole("dialog", { name: "Security check" })
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Verify test visitor" })
    )
    await waitFor(() =>
      expect(within(canvasElement).getByText("Welcome, guest")).toBeVisible()
    )
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(
        getComputedStyle(
          within(canvasElement).getByText("Welcome, guest").closest("article")!
        ).opacity
      ).toBe("1")
    )
  },
}
export const Setup: Story = {
  render: () => <ShopifyChatSetup connectionId="store-connection" />,
  parameters: {
    msw: {
      handlers: [
        http.post("*/api/build/:operation", ({ params }) =>
          HttpResponse.json({
            data:
              params.operation === "build_list_channels"
                ? [
                    {
                      id: channelId,
                      channel: "web",
                      status: "connected",
                      label: "Store support",
                    },
                  ]
                : {
                    themeEditorUrl:
                      "https://fixture.myshopify.com/admin/themes/current/editor?context=apps",
                  },
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const select = await canvas.findByRole("combobox", {
      name: "Storefront chat",
    })
    await userEvent.selectOptions(select, channelId)
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect chat bubble" })
    )
    await expect(
      canvas.findByRole("link", { name: "Open theme editor" })
    ).resolves.toHaveAttribute(
      "href",
      "https://fixture.myshopify.com/admin/themes/current/editor?context=apps"
    )
  },
}

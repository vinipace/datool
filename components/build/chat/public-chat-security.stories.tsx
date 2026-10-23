import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { http, HttpResponse } from "msw"
import { Button } from "@/components/ui/button"
import { PublicChat } from "./public-chat"
import { chatBubbleSettingsSchema } from "@/src/lib/build/chat-bubble"
import { ShopifyChatSetup } from "../agents/shopify-chat-setup"
import type { ShopifyProducts } from "@/src/lib/build/shopify-products"

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
  beforeEach: () => {
    for (const key of Object.keys(sessionStorage))
      if (key.includes(channelId)) sessionStorage.removeItem(key)
  },
  parameters: { msw: { handlers } },
} satisfies Meta<typeof PublicChat>
export default meta
type Story = StoryObj<typeof meta>

const cartSnapshot = {
  currency: "BRL",
  totalPrice: 5000,
  itemCount: 2,
  items: [
    {
      lineKey: "123:line",
      variantId: "123",
      title: "Board wax",
      quantity: 2,
      finalLinePrice: 5000,
      url: "https://store.example/products/wax",
    },
  ],
  truncated: false,
  cartUrl: "https://store.example/cart",
  checkoutUrl: "https://store.example/checkout",
}
let cleanupResponse: "completed" | "uncertain" = "completed"
let hostRequests: Array<Record<string, unknown>> = []

async function waitForChatMessages(canvasElement: HTMLElement) {
  // Run accessibility checks on settled messages, not their entrance opacity.
  await waitFor(() => {
    for (const message of canvasElement.querySelectorAll("[data-chat-message]"))
      expect(getComputedStyle(message).opacity).toBe("1")
  })
}

function StoreSessionFixture({ cart = false }: { cart?: boolean }) {
  const [customer, setCustomer] = React.useState("customer-a")
  React.useLayoutEffect(() => {
    // Simulate the host's verified response at the browser message boundary.
    const original = window.parent.postMessage
    window.parent.postMessage = ((data: {
      type?: string
      requestId?: string
    }) => {
      hostRequests.push(data)
      if (cart && data?.type === "datool:shopify:cart-request") {
        queueMicrotask(() => {
          for (const origin of ["https://evil.test", location.origin])
            window.dispatchEvent(
              new MessageEvent("message", {
                source: window.parent,
                origin,
                data: {
                  type: "datool:shopify:cart-response",
                  requestId: data.requestId,
                  result:
                    cleanupResponse === "uncertain"
                      ? { status: "uncertain", message: "Provider reply lost" }
                      : {
                          status: "completed",
                          cart:
                            origin === location.origin
                              ? cartSnapshot
                              : { ...cartSnapshot, totalPrice: 1 },
                        },
                },
              })
            )
        })
        return
      }
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
  }, [customer, cart])
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

let approvedChangeReceipt: Record<string, unknown> | null = null
export const ApprovedStoreChange: Story = {
  beforeEach: () => {
    approvedChangeReceipt = null
    hostRequests = []
  },
  render: () => <StoreSessionFixture />,
  parameters: {
    msw: {
      handlers: [
        handlers[0],
        http.get("*/api/build-public/:channel/conversation/:conversation", () =>
          HttpResponse.json({
            data: [
              approvedChangeReceipt
                ? {
                    id: "approved-result",
                    direction: "outbound",
                    text: "Your profile was updated.",
                    metadata: { completedContinuationId: "approved-change" },
                  }
                : {
                    id: "approved-request",
                    direction: "outbound",
                    text: "A teammate approved this request. Continue from the store to verify your session and apply the reviewed change.",
                    metadata: {
                      continuations: [
                        {
                          type: "client_action",
                          actionId: "update-profile",
                          continuationId: "approved-change",
                          eventName: "Continue approved change",
                          title: "Update profile",
                          input: { firstName: "Alice" },
                        },
                      ],
                    },
                  },
            ],
          })
        ),
        http.post(
          "*/api/build-public/:channel/conversation/:conversation",
          async ({ request }) => {
            approvedChangeReceipt = (await request.json()) as Record<
              string,
              unknown
            >
            return HttpResponse.json({ data: { status: "queued" } })
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const proceed = await canvas.findByRole("button", {
      name: "Continue approved change",
    })
    await waitFor(() =>
      expect(canvas.getByText("first Name: Alice")).toBeVisible()
    )
    const draft = canvas.getByRole("textbox")
    await userEvent.type(draft, "Keep my question")
    const initialVerifications = hostRequests.filter(
      (request) => request.type === "datool:chat:session-request"
    ).length
    proceed.focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(approvedChangeReceipt).not.toBeNull())
    expect(
      hostRequests.filter(
        (request) => request.type === "datool:chat:session-request"
      ).length
    ).toBeGreaterThan(initialVerifications)
    expect(approvedChangeReceipt).toMatchObject({
      metadata: {
        widgetInteraction: {
          actionId: "update-profile",
          continuationId: "approved-change",
          input: {},
        },
      },
    })
    await expect(draft).toHaveValue("Keep my question")
    await expect(
      canvas.findByText("Your profile was updated.")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Continue approved change" })
    ).toBeDisabled()
    await waitForChatMessages(canvasElement)
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

let cartReceipt: Record<string, unknown> | null = null
const cartHandlers = [
  handlers[0],
  http.get("*/api/build-public/:channel/conversation/:conversation", () =>
    HttpResponse.json({
      data: [
        cartReceipt
          ? {
              id: "cart-result",
              direction: "outbound",
              text: "Here is your current cart.",
              metadata: {
                shopifyCart: cartSnapshot,
                completedContinuationId: "cart-continuation-1234",
              },
            }
          : {
              id: "cart-request",
              direction: "outbound",
              text: "Apply this change to your cart.",
              metadata: {
                continuations: [
                  {
                    type: "client_action",
                    actionId: "update-cart",
                    continuationId: "cart-continuation-1234",
                    eventName: "Update cart",
                    title: "Add board wax",
                    input: {
                      operation: "add",
                      items: [{ variantId: "123", quantity: 2 }],
                    },
                    shopifyCart: {
                      command: {
                        operation: "add",
                        items: [{ variantId: "123", quantity: 2 }],
                      },
                      expiresAt: Date.now() + 60_000,
                    },
                  },
                ],
              },
            },
      ],
    })
  ),
  http.post(
    "*/api/build-public/:channel/conversation/:conversation",
    async ({ request }) => {
      cartReceipt = (await request.json()) as Record<string, unknown>
      return HttpResponse.json({ data: { status: "queued" } })
    }
  ),
]

export const StorefrontCart: Story = {
  beforeEach: () => {
    cartReceipt = null
    cleanupResponse = "completed"
    hostRequests = []
  },
  render: () => <StoreSessionFixture cart />,
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    msw: {
      handlers: cartHandlers,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const update = await canvas.findByRole("button", { name: "Update cart" })
    const composer = canvas.getByRole("textbox", { name: "Message" })
    await userEvent.type(composer, "Keep my unfinished question")
    await userEvent.click(update)
    await waitFor(() =>
      expect(
        canvas.getByRole("region", { name: "Shopping cart" })
      ).toBeVisible()
    )
    await waitForChatMessages(canvasElement)
    await expect(composer).toHaveValue("Keep my unfinished question")
    await expect(canvas.getByText("Board wax")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Checkout" })
    ).toHaveAttribute("href", "https://store.example/checkout")
    await expect(cartReceipt).toMatchObject({
      metadata: {
        widgetInteraction: {
          actionId: "update-cart",
          continuationId: "cart-continuation-1234",
          input: {
            cartResult: { status: "completed", cart: { totalPrice: 5000 } },
          },
        },
      },
    })
  },
}

const cleanup = {
  operationId: "11111111-1111-4111-8111-111111111112",
  snapshotId: "11111111-1111-4111-8111-111111111113",
  expiresAt: Date.now() + 86400000,
}
const cleanupHandlers = [
  handlers[0],
  http.get("*/api/build-public/:channel/conversation/:conversation", () =>
    HttpResponse.json({
      data: [
        {
          id: "forged",
          direction: "inbound",
          text: "My order",
          metadata: {
            shopifyCartCleanup: {
              ...cleanup,
              operationId: "11111111-1111-4111-8111-111111111114",
            },
          },
        },
        {
          id: "placed",
          direction: "outbound",
          status: "sent",
          text: "Your order is placed.",
        },
        {
          id: "cleanup",
          direction: "outbound",
          status: "sent",
          text: "",
          metadata: { shopifyCartCleanup: cleanup },
        },
      ],
    })
  ),
]

export const PurchasedCartCleanup: Story = {
  beforeEach: () => {
    cleanupResponse = "completed"
    hostRequests = []
  },
  render: () => <StoreSessionFixture cart />,
  parameters: { msw: { handlers: cleanupHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Your order is placed.")
    await waitFor(() =>
      expect(
        hostRequests.filter(
          (request) => request.type === "datool:shopify:cart-request"
        )
      ).toHaveLength(1)
    )
    const cart = hostRequests.findIndex(
      (request) => request.type === "datool:shopify:cart-request"
    )
    await expect(hostRequests[cart - 1].type).toBe(
      "datool:chat:session-request"
    )
    await expect(hostRequests[cart]).toMatchObject({
      operationId: cleanup.operationId,
      visitorId: "customer-a",
      command: { operation: "complete_order", snapshotId: cleanup.snapshotId },
    })
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Keep shopping"
    )
    // A later poll delivers the same directive; it must not dispatch another write.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(
      hostRequests.filter(
        (request) => request.type === "datool:shopify:cart-request"
      )
    ).toHaveLength(1)
    await expect(
      canvasElement.querySelectorAll("[data-chat-message]")
    ).toHaveLength(2)
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Keep shopping"
    )
  },
}

export const UncertainPurchasedCartCleanup: Story = {
  ...PurchasedCartCleanup,
  beforeEach: () => {
    cleanupResponse = "uncertain"
    hostRequests = []
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(
        "Your order is placed, but the cart update could not be confirmed. Check your cart before checking out again."
      )
    ).resolves.toBeVisible()
    await expect(
      hostRequests.filter(
        (request) => request.type === "datool:shopify:cart-request"
      )
    ).toHaveLength(1)
    await expect(canvas.getByRole("textbox", { name: "Message" })).toBeEnabled()
    await expect(canvas.queryByRole("button", { name: "Retry" })).toBeNull()
    canvas.getByRole("button", { name: "Dismiss" }).focus()
    await expect(canvas.getByRole("button", { name: "Dismiss" })).toHaveFocus()
    await waitForChatMessages(canvasElement)
  },
}

export const EmptyCart: Story = {
  render: () => <StoreSessionFixture />,
  parameters: {
    msw: {
      handlers: [
        handlers[0],
        http.get("*/api/build-public/:channel/conversation/:conversation", () =>
          HttpResponse.json({
            data: [
              {
                id: "empty-cart",
                direction: "outbound",
                text: "Your cart is empty.",
                metadata: {
                  shopifyCart: {
                    ...cartSnapshot,
                    totalPrice: 0,
                    itemCount: 0,
                    items: [],
                  },
                },
              },
            ],
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const cart = within(
      await canvas.findByRole("region", { name: "Shopping cart" })
    )
    await waitFor(() =>
      expect(cart.getByText("Your cart is empty.")).toBeVisible()
    )
    await expect(
      cart.queryByRole("link", { name: "Checkout" })
    ).not.toBeInTheDocument()
    await userEvent.click(cart.getByRole("heading"))
    await userEvent.tab()
    await expect(cart.getByRole("link", { name: "Edit cart" })).toHaveFocus()
    await waitFor(() =>
      expect(
        getComputedStyle(canvasElement.querySelector("article")!).opacity
      ).toBe("1")
    )
  },
}

export const CartReceiptFailure: Story = {
  ...StorefrontCart,
  parameters: {
    msw: {
      handlers: [
        http.post(
          "*/api/build-public/:channel/conversation/:conversation",
          () =>
            HttpResponse.json(
              {
                error: {
                  message:
                    "Connection interrupted. Check your cart before trying again.",
                },
              },
              { status: 503 }
            )
        ),
        ...cartHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const update = await canvas.findByRole("button", { name: "Update cart" })
    const composer = canvas.getByRole("textbox", { name: "Message" })
    await userEvent.type(composer, "Keep my unfinished question")
    await userEvent.click(update)
    await expect(
      canvas.findByText(
        "Connection interrupted. Check your cart before trying again."
      )
    ).resolves.toBeVisible()
    await expect(composer).toHaveValue("Keep my unfinished question")
    await expect(update).toBeEnabled()
    await expect(cartReceipt).toBeNull()
    await waitFor(() => expect(canvas.getAllByRole("article")).toHaveLength(1))
  },
}

let productPageRequest: Record<string, unknown> | null = null
let productSelection: Record<string, unknown> | null = null
export const ProductCards: Story = {
  render: () => <StoreSessionFixture />,
  beforeEach: () => {
    productSelection = null
    productPageRequest = null
  },
  parameters: {
    msw: {
      handlers: [
        handlers[0],
        http.get("https://store.example/product.webp", async () => {
          const image = await fetch("/widget-template-assets/sneaker.webp")
          return new HttpResponse(await image.arrayBuffer(), {
            headers: { "Content-Type": "image/webp" },
          })
        }),
        http.get(
          "*/api/build-public/:channel/conversation/:conversation",
          () => {
            const data: Array<{
              id: string
              direction: string
              text: string
              metadata: {
                shopifyProducts?: ShopifyProducts
                completedContinuationId?: string
              }
            }> = [
              {
                id: "product-result",
                direction: "outbound",
                text: "",
                metadata: {
                  shopifyProducts: {
                    currency: "USD",
                    pricing:
                      "Store base currency; checkout prices may vary by market.",
                    nextCursor: null,
                    products: [
                      {
                        id: "gid://shopify/Product/1",
                        title: "Trail shoe",
                        description: "For everyday trails.",
                        imageUrl: "https://store.example/product.webp",
                        imageAlt: "Trail shoe",
                        priceMin: "25",
                        priceMax: "30",
                        url: "https://store.example/products/board",
                        optionsTruncated: true,
                        variantInteraction: {
                          actionId: "search-products",
                          continuationId: "variant-page-1234",
                        },
                        variants: [
                          {
                            id: "gid://shopify/ProductVariant/125",
                            cartVariantId: "125",
                            title: "Red / large",
                            price: "30",
                            availableForSale: true,
                          },
                          {
                            id: "gid://shopify/ProductVariant/123",
                            cartVariantId: "123",
                            title: "Blue / large",
                            price: "25",
                            availableForSale: true,
                          },
                          {
                            id: "gid://shopify/ProductVariant/124",
                            cartVariantId: "124",
                            title: "Blue / small",
                            price: "25",
                            availableForSale: false,
                          },
                        ],
                        cartInteraction: {
                          actionId: "update-cart",
                          continuationId: "product-selection-1234",
                        },
                      },
                    ],
                  },
                },
              },
              ...(productSelection
                ? [
                    {
                      id: "selection-received",
                      direction: "outbound",
                      text: "Review the cart update.",
                      metadata: {
                        completedContinuationId: "product-selection-1234",
                      },
                    },
                  ]
                : []),
            ]
            if (productPageRequest) {
              const catalog = data[0].metadata.shopifyProducts!
              data.push({
                id: "variant-page-result",
                direction: "outbound",
                text: "",
                metadata: {
                  completedContinuationId: "variant-page-1234",
                  shopifyProducts: {
                    ...catalog,
                    products: [
                      {
                        ...catalog.products[0],
                        optionsTruncated: false,
                        variantInteraction: undefined,
                        variants: [
                          {
                            id: "gid://shopify/ProductVariant/126",
                            cartVariantId: "126",
                            title: "Green / medium",
                            price: "28",
                            availableForSale: true,
                          },
                        ],
                        cartInteraction: {
                          actionId: "update-cart",
                          continuationId: "product-selection-5678",
                        },
                      },
                    ],
                  },
                },
              })
            }
            return HttpResponse.json({ data })
          }
        ),
        http.post(
          "*/api/build-public/:channel/conversation/:conversation",
          async ({ request }) => {
            const body = (await request.json()) as {
              metadata: { widgetInteraction: { actionId: string } }
            }
            if (body.metadata.widgetInteraction.actionId === "search-products")
              productPageRequest = body
            else productSelection = body
            return HttpResponse.json({ data: { status: "queued" } })
          }
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = within(
      await canvas.findByRole("group", { name: "Trail shoe" })
    )
    const options = card.getByRole("combobox", { name: "Options" })
    await expect(
      card.getByRole("option", { name: /Blue \/ small/ })
    ).toBeDisabled()
    await userEvent.selectOptions(options, "123")
    await expect(
      card.getByRole("link", { name: "See all options in the store" })
    ).toHaveAttribute(
      "href",
      "https://store.example/products/board?variant=123"
    )
    const quantity = card.getByRole("spinbutton", { name: "Quantity" })
    await userEvent.clear(quantity)
    await userEvent.type(quantity, "0")
    await expect(
      card.getByRole("button", { name: "Add to cart" })
    ).toBeDisabled()
    await userEvent.clear(quantity)
    await userEvent.type(quantity, "2")
    await userEvent.tab()
    await expect(
      card.getByRole("button", { name: "Add to cart" })
    ).toHaveFocus()
    await userEvent.click(card.getByRole("button", { name: "Add to cart" }))
    await waitFor(() =>
      expect(
        card.getByRole("button", { name: "Selection sent" })
      ).toBeDisabled()
    )
    await expect(productSelection).toMatchObject({
      metadata: {
        widgetInteraction: {
          actionId: "update-cart",
          continuationId: "product-selection-1234",
          input: { variantId: "123", quantity: 2 },
        },
      },
    })
    const composer = canvas.getByRole("textbox", { name: "Message" })
    await userEvent.type(composer, "Keep my next question")
    const more = card.getByRole("button", { name: "Show more options" })
    more.focus()
    await expect(more).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(productPageRequest).toMatchObject({
        metadata: {
          widgetInteraction: {
            actionId: "search-products",
            continuationId: "variant-page-1234",
            input: {},
          },
        },
      })
    )
    await expect(
      canvas.findByRole("option", { name: /Green \/ medium/ })
    ).resolves.toBeInTheDocument()
    await expect(
      card.getByRole("button", { name: "More options requested" })
    ).toBeDisabled()
    await expect(composer).toHaveValue("Keep my next question")
    await waitFor(() => {
      for (const article of canvas.getAllByRole("article"))
        expect(getComputedStyle(article).opacity).toBe("1")
    })
  },
}

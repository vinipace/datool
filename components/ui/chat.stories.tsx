import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Chat } from "./chat"

const submitted = fn()

function Conversation(props: React.ComponentProps<typeof Chat>) {
  const [text, setText] = useState(props.text)
  return (
    <form
      className="h-96 w-full max-w-lg"
      onSubmit={(event) => {
        event.preventDefault()
        submitted(text)
      }}
    >
      <Chat
        {...props}
        text={text}
        onTextChange={setText}
        canSubmit={!props.running && Boolean(text.trim())}
      />
    </form>
  )
}

const meta = {
  title: "UI/Chat",
  component: Chat,
  args: {
    messages: [],
    text: "",
    onTextChange: fn(),
    running: false,
    canSubmit: false,
  },
  beforeEach: () => {
    submitted.mockClear()
  },
  render: (args) => <Conversation {...args} />,
} satisfies Meta<typeof Chat>
export default meta
type Story = StoryObj<typeof meta>

export const Compose: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Start a conversation")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Hello"
    )
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeEnabled()
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Again")
    await expect(submitted).not.toHaveBeenCalled()
    await userEvent.keyboard("{Enter}")
    await expect(submitted).toHaveBeenLastCalledWith("Hello\nAgain")
  },
}

export const ShopifyConfirmation: Story = {
  args: {
    messages: [
      {
        role: "assistant",
        content: "Review this change.",
        toolCalls: [],
        metadata: {
          continuations: [
            {
              type: "client_action",
              actionId: "profile",
              continuationId: "one-shot-confirmation",
              eventName: "Confirm changes",
              title: "Update profile",
              input: { firstName: "Alice", email: "alice@example.test" },
            },
          ],
        },
      },
    ],
    onWidgetInteraction: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/first Name: Alice/)).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Confirm changes" })
    )
    await expect(args.onWidgetInteraction).toHaveBeenCalledOnce()
  },
}

function orderConfirmation(
  paymentMethod: "online" | "cash_on_delivery" | "free",
  button: string,
  description: string
): Story {
  const amount = paymentMethod === "free" ? "0" : "57"
  return {
    render: (args) => (
      <div className="h-[42rem] w-full max-w-lg">
        <Chat {...args} />
      </div>
    ),
    args: {
      messages: [
        {
          role: "assistant",
          content: "Review your order before continuing.",
          toolCalls: [],
          metadata: {
            continuations: [
              {
                type: "client_action",
                actionId: "create-order",
                continuationId: "order-confirmation",
                eventName: "Confirm changes",
                title: "Create order",
                input: {},
                shopifyOrderQuote: {
                  operationId: "aadae85e-4ed6-4dbe-9444-9ad1dfdfd3e9",
                  expiresAt: Date.now() + 60_000,
                  customerId: null,
                  fingerprint: "a".repeat(64),
                  paymentMethod,
                  input: {
                    items: [{ variantId: "123", quantity: 2 }],
                    email: "alice@example.test",
                    shippingAddress: {
                      firstName: "Alice",
                      address1: "123 Main St",
                      city: "Austin",
                      countryCode: "US",
                    },
                  },
                  items: [{ title: "Board wax", quantity: 2 }],
                  shippingTitle: "Ground",
                  subtotal: {
                    amount: paymentMethod === "free" ? "0" : "50",
                    currencyCode: "USD",
                  },
                  shipping: {
                    amount: paymentMethod === "free" ? "0" : "5",
                    currencyCode: "USD",
                  },
                  tax: {
                    amount: paymentMethod === "free" ? "0" : "2",
                    currencyCode: "USD",
                  },
                  total: { amount, currencyCode: "USD" },
                },
              },
            ],
          },
        },
      ],
      onWidgetInteraction: fn(),
    },
    play: async ({ canvasElement, args }) => {
      const canvas = within(canvasElement)
      await expect(canvas.getByText(/2 × Board wax/)).toBeVisible()
      await expect(
        canvas.getByText(new RegExp(`Total: USD ${amount}`))
      ).toBeVisible()
      await expect(canvas.getByText(new RegExp(description))).toBeVisible()
      await expect(
        canvas.getByText(/Contact: alice@example.test/)
      ).toBeVisible()
      await expect(canvas.queryByText(/fingerprint/)).not.toBeInTheDocument()
      const confirm = canvas.getByRole("button", { name: button })
      confirm.focus()
      await expect(confirm).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expect(args.onWidgetInteraction).toHaveBeenCalledOnce()
    },
  }
}

export const OnlineOrder: Story = orderConfirmation(
  "online",
  "Create checkout",
  "Pay through Shopify checkout"
)
export const CashOnDeliveryOrder: Story = orderConfirmation(
  "cash_on_delivery",
  "Place order",
  "Payment remains outstanding"
)
export const FreeOrder: Story = orderConfirmation(
  "free",
  "Place free order",
  "No payment will be collected"
)

export const Waiting: Story = {
  args: {
    messages: [{ role: "user", content: "Hello", toolCalls: [] }],
    text: "A retained draft",
    running: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("log", { name: "Conversation" })
    ).toHaveAttribute("aria-busy", "true")
    await expect(
      canvas.getByRole("textbox", { name: "Message" })
    ).toHaveAttribute("readonly")
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await expect(canvas.getByText("Hello")).toBeVisible()
  },
}

const longMessage = "https://example.test/" + "long-path-segment-".repeat(24)

export const MessageWrapping: Story = {
  args: {
    messages: [
      { role: "user", content: "hey", toolCalls: [] },
      { role: "user", content: longMessage, toolCalls: [] },
      { role: "assistant", content: "How can I help?", toolCalls: [] },
    ],
  },
  render: (args) => (
    <div className="flex flex-wrap gap-8">
      {[320, 640].map((width) => (
        <section
          key={width}
          aria-label={`Chat at ${width}px`}
          className="h-[32rem] max-w-full"
          style={{ width }}
        >
          <Chat {...args} />
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const width of [320, 640]) {
      const chat = within(
        canvas.getByRole("region", { name: `Chat at ${width}px` })
      )
      const short = chat.getByText("hey", { exact: true })
      const range = short.ownerDocument.createRange()
      range.selectNodeContents(short)
      await expect(range.getClientRects().length).toBe(1)

      const long = chat.getByRole("link", { name: longMessage }).closest("p")!
      await expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth)
      const log = chat.getByRole("log", { name: "Conversation" })
      await expect(log.scrollWidth).toBeLessThanOrEqual(log.clientWidth)
      await expect(short.getBoundingClientRect().right).toBeGreaterThan(
        log.getBoundingClientRect().left + log.clientWidth / 2
      )
    }
  },
}

function returnConfirmation(exchange: boolean): Story {
  return {
    render: (args) => (
      <div className="h-[42rem] w-full max-w-lg">
        <Chat {...args} />
      </div>
    ),
    args: {
      messages: [
        {
          role: "assistant",
          content: "Review the return before continuing.",
          toolCalls: [],
          metadata: {
            continuations: [
              {
                type: "client_action",
                actionId: "return-items",
                continuationId: "return-confirmation",
                eventName: "Confirm changes",
                title: "Return or exchange items",
                input: {},
                shopifyReturnQuote: {
                  operationId: "aadae85e-4ed6-4dbe-9444-9ad1dfdfd3e9",
                  expiresAt: Date.now() + 60_000,
                  customerId: null,
                  fingerprint: "a".repeat(64),
                  orderName: "1001",
                  input: {
                    orderId: "gid://shopify/Order/10",
                    items: [
                      {
                        fulfillmentLineItemId:
                          "gid://shopify/FulfillmentLineItem/101",
                        quantity: 1,
                      },
                    ],
                    replacements: exchange
                      ? [{ variantId: "60", quantity: 1 }]
                      : [],
                    reason: "Wrong size",
                  },
                  items: [{ title: "Board wax", quantity: 1 }],
                  replacements: exchange
                    ? [{ title: "Replacement wax (Large)", quantity: 1 }]
                    : [],
                  credit: { amount: "19.7", currencyCode: "USD" },
                  replacementTotal: {
                    amount: exchange ? "20.1" : "0",
                    currencyCode: "USD",
                  },
                  settlement: {
                    direction: exchange ? "collect" : "refund",
                    amount: exchange ? "0.4" : "19.7",
                    currencyCode: "USD",
                  },
                },
              },
            ],
          },
        },
      ],
      onWidgetInteraction: fn(),
    },
    play: async ({ canvasElement, args }) => {
      const canvas = within(canvasElement)
      await expect(canvas.getByText(/Return: 1 × Board wax/)).toBeVisible()
      await expect(
        canvas.getByText(
          exchange ? /Additional payment: USD 0.4/ : /Refund: USD 19.7/
        )
      ).toBeVisible()
      await expect(
        canvas.queryByText(/fulfillmentLineItemId|fingerprint/)
      ).not.toBeInTheDocument()
      const button = canvas.getByRole("button", {
        name: exchange ? "Confirm exchange" : "Confirm return",
      })
      button.focus()
      await expect(button).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await expect(args.onWidgetInteraction).toHaveBeenCalledOnce()
    },
  }
}
export const ShopifyRefund: Story = returnConfirmation(false)
export const ShopifyExchange: Story = returnConfirmation(true)

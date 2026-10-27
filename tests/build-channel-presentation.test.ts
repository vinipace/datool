import { expect, test } from "bun:test"
import { runtimeChannelMessage } from "@/src/server/build/runtime/continuations"
import type { RunAgentTurnResult } from "@/src/server/build/runtime"

const products = {
  currency: "BRL",
  pricing: "Store currency",
  nextCursor: null,
  products: [1, 2, 3, 4].map((id) => ({
    id: `gid://shopify/Product/${id}`,
    title: `Board ${id}`,
    description: "",
    imageUrl: null,
    imageAlt: "",
    priceMin: "100.00",
    priceMax: "100.00",
    url: `https://fixture.myshopify.com/products/board-${id}`,
    optionsTruncated: false,
    variants: [],
  })),
}
const cart = {
  currency: "BRL",
  totalPrice: 10000,
  itemCount: 1,
  truncated: false,
  cartUrl: "https://fixture.myshopify.com/cart",
  checkoutUrl: "https://fixture.myshopify.com/cart/123:1",
  items: [
    {
      lineKey: "123",
      variantId: "123",
      title: "Board 1",
      quantity: 1,
      finalLinePrice: 10000,
      url: "https://fixture.myshopify.com/products/board-1",
    },
  ],
}
function result(
  channel: "web" | "whatsapp" | "telegram",
  text: string,
  metadata: Record<string, unknown>
) {
  return {
    conversation: { channel },
    text,
    message: { metadata },
  } as RunAgentTurnResult
}

for (const channel of ["whatsapp", "telegram"] as const) {
  test(`${channel} delivers the agent's product selection once, without adding other search results`, () => {
    const text =
      "Three products:\nBoard 1 — 100 BRL\nBoard 2 — 100 BRL\nBoard 3 — 100 BRL"
    expect(
      runtimeChannelMessage(
        result(channel, text, { shopifyProducts: products }),
        []
      ).text
    ).toBe(text)
  })
}
test("text-only channels still render products when the runtime has no reply text", () => {
  const message = runtimeChannelMessage(
    result("whatsapp", "", { shopifyProducts: products }),
    []
  )
  expect(message.text).toContain(
    "Board 1 — 100.00 BRL\nhttps://fixture.myshopify.com/products/board-1"
  )
  expect(message.text).toContain("Board 4")
})
test("web retains native product data without appending text results", () => {
  const message = runtimeChannelMessage(
    result("web", "Selected products", { shopifyProducts: products }),
    []
  )
  expect(message.text).toBe("Selected products")
  expect(message.metadata.shopifyProducts).toEqual(products)
})
test("cart checkout is appended when missing, but not repeated when already in the reply", () => {
  const text = `Added Board 1. Checkout: ${cart.checkoutUrl}`
  expect(
    runtimeChannelMessage(result("whatsapp", text, { shopifyCart: cart }), [])
      .text
  ).toBe(text)
  expect(
    runtimeChannelMessage(
      result("whatsapp", "Added Board 1.", { shopifyCart: cart }),
      []
    ).text
  ).toContain(cart.checkoutUrl)
  expect(
    runtimeChannelMessage(result("whatsapp", "", { shopifyCart: cart }), [])
      .text
  ).toContain("1 × Board 1")
})

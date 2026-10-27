import { expect, test } from "bun:test"
import { whatsappText } from "@/src/server/build/channels/whatsapp-text"

test("renders product name and price together with a separate shortened URL", () => {
  expect(
    whatsappText(
      "Aqui vão 2 produtos:\n\n- [Board](https://shop.example/products/board) — **R$ 99,00**\n- [Wax](https://shop.example/products/wax) — **R$ 9,00**",
      (url) =>
        url.endsWith("board")
          ? "https://datool.example/l/board"
          : "https://datool.example/l/wax"
    )
  ).toBe(
    "Aqui vão 2 produtos:\n\n• Board — *R$ 99,00*\nhttps://datool.example/l/board\n\n• Wax — *R$ 9,00*\nhttps://datool.example/l/wax"
  )
})
test("handles bare URLs, references, punctuation and query strings without Markdown link syntax", () => {
  const urls: string[] = []
  const text = whatsappText(
    "Checkout: https://shop.example/cart/12:1?discount=SAVE&ref=a.\n\n[Policy][policy]\n\n[policy]: https://shop.example/policy",
    (url) => {
      urls.push(url)
      return "https://datool.example/l/link"
    }
  )
  expect(urls).toEqual([
    "https://shop.example/cart/12:1?discount=SAVE&ref=a",
    "https://shop.example/policy",
  ])
  expect(text).not.toContain("](")
  expect(text).toContain("Checkout:\nhttps://datool.example/l/link.")
})
test("leaves code literal and removes unsafe link targets", () => {
  const urls: string[] = []
  expect(
    whatsappText(
      "`[code](https://example.com)`\n\n[bad](javascript:alert)\n\n# Heading",
      (url) => {
        urls.push(url)
        return url
      }
    )
  ).toBe("`[code](https://example.com)`\n\nbad\n\n*Heading*")
  expect(urls).toEqual([])
})

test("keeps native WhatsApp bold in existing agent replies", () => {
  expect(whatsappText("Total: *R$ 949,95*.")).toBe("Total: *R$ 949,95*.")
})

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const source = readFileSync(
  new URL("../public/datool-widget.js", import.meta.url),
  "utf8"
)

// Exercise the shipped, dependency-free browser loader at its DOM/message boundary.
async function storefront(
  storage = new Map<string, string>(),
  channelId = "channel-one"
) {
  class Element {
    style: Record<string, string> = {}
    attributes: Record<string, string> = {}
    children: Element[] = []
    events: Record<string, () => void> = {}
    contentWindow = {}
    textContent = ""
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    }
    appendChild(child: Element) {
      this.children.push(child)
      return child
    }
    replaceChildren() {
      this.children = []
    }
    addEventListener(name: string, listener: () => void) {
      this.events[name] = listener
    }
    remove() {}
  }
  const elements: Array<{ tag: string; element: Element }> = []
  const listeners = new Map<string, (event: unknown) => void>()
  const navigations: string[] = []
  const window = {
    location: {
      origin: "https://store.example",
      href: "https://store.example/",
      assign: (href: string) => navigations.push(href),
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    DatoolWidget: undefined as undefined | { open(): void; close(): void },
  }
  const document = {
    currentScript: {
      src: "https://chat.example/datool-widget.js",
      dataset: { channelId },
    },
    body: new Element(),
    createElement: (tag: string) => {
      const element = new Element()
      elements.push({ tag, element })
      return element
    },
    createElementNS: (_ns: string, tag: string) => document.createElement(tag),
    createTextNode: () => new Element(),
  }
  runInNewContext(source, {
    window,
    document,
    URL,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        data: {
          appearance: { offsetX: 20, offsetY: 20, fontSize: 14 },
          launcher: { color: "#111111" },
        },
      }),
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const frame = elements.find((item) => item.tag === "iframe")!.element
  return {
    window,
    frame,
    navigations,
    receive: (
      data: unknown,
      source = frame.contentWindow,
      origin = "https://chat.example"
    ) => listeners.get("message")?.({ data, source, origin }),
  }
}

test("store links navigate the host and the chat reopens after a page load", async () => {
  const storage = new Map<string, string>()
  const first = await storefront(storage)
  first.window.DatoolWidget!.open()
  first.receive({
    type: "datool:chat:navigate",
    href: "https://store.example/products/board",
  })
  expect(first.navigations).toEqual(["https://store.example/products/board"])
  const second = await storefront(storage)
  expect(second.frame.style.display).toBe("block")
  second.window.DatoolWidget!.close()
  expect((await storefront(storage)).frame.attributes["aria-hidden"]).toBe(
    "true"
  )
  expect(
    (await storefront(storage, "different-channel")).frame.attributes[
      "aria-hidden"
    ]
  ).toBe("true")
})

test("navigation ignores forged messages and destinations outside the host origin", async () => {
  const page = await storefront()
  const message = {
    type: "datool:chat:navigate",
    href: "https://store.example/products/board",
  }
  page.receive(message, {})
  page.receive(message, page.frame.contentWindow, "https://attacker.example")
  for (const href of [
    "https://attacker.example",
    "https://store.example.attacker.example",
    "https://user:secret@store.example",
    "javascript:alert(1)",
    "https://store.example:444/products/board",
  ])
    page.receive({ ...message, href })
  expect(page.navigations).toEqual([])
  page.receive(message)
  expect(page.navigations).toEqual([message.href])
})

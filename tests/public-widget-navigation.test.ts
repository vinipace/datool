import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const source = readFileSync(
  new URL("../public/datool-widget.js", import.meta.url),
  "utf8"
)

const cartLocks = new WeakMap<
  Map<string, string>,
  Map<string, Promise<unknown>>
>()

// Exercise the shipped, dependency-free browser loader at its DOM/message boundary.
async function storefront(
  storage = new Map<string, string>(),
  channelId = "channel-one",
  proxy?: { path: string; respond: (body: Record<string, unknown>) => unknown },
  cart?: { respond: (url: string, body?: string) => Promise<Response> }
) {
  class Element {
    style: Record<string, string> = {}
    attributes: Record<string, string> = {}
    children: Element[] = []
    events: Record<string, () => void> = {}
    messages: unknown[] = []
    contentWindow = {
      postMessage: (message: unknown) => this.messages.push(message),
    }
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
  const events: unknown[] = []
  const locks = cartLocks.get(storage) ?? new Map<string, Promise<unknown>>()
  cartLocks.set(storage, locks)
  const window = {
    location: {
      origin: "https://store.example",
      href: "https://store.example/",
      assign: (href: string) => navigations.push(href),
    },
    Shopify: { routes: { root: "/pt-br/" } },
    navigator: {
      locks: {
        request: (name: string, callback: () => Promise<unknown>) => {
          const operation = (locks.get(name) ?? Promise.resolve())
            .catch(() => undefined)
            .then(callback)
          locks.set(name, operation)
          return operation
        },
      },
    },
    dispatchEvent: (event: unknown) => {
      events.push(event)
      return true
    },
    localStorage: {
      get length() {
        return storage.size
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      removeItem: (key: string) => storage.delete(key),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
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
      dataset: { channelId, ...(proxy ? { shopifyProxy: proxy.path } : {}) },
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
    Promise,
    AbortSignal,
    CustomEvent,
    fetch: async (url: string, init?: { body?: string }) =>
      cart && url.includes("/cart")
        ? cart.respond(url, init?.body)
        : proxy && url.includes(proxy.path)
          ? {
              ok: true,
              json: async () => proxy.respond(JSON.parse(init?.body || "{}")),
            }
          : {
              ok: true,
              json: async () => ({
                data: {
                  appearance: { offsetX: 20, offsetY: 20, fontSize: 14 },
                  launcher: { color: "#111111" },
                },
              }),
            },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const frame = elements.find((item) => item.tag === "iframe")!.element
  return {
    window,
    frame,
    navigations,
    events,
    receive: (
      data: unknown,
      source: unknown = frame.contentWindow,
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

test("guest identity persists in first-party storage and is only exchanged with the owned frame", async () => {
  const storage = new Map<string, string>()
  const first = await storefront(storage)
  const session = {
    visitorToken: "guest-bearer",
    conversationId: "guest-thread",
  }
  first.receive(
    { type: "datool:chat:session-save", session },
    {},
    "https://evil.test"
  )
  expect(storage.size).toBe(0)
  first.receive({ type: "datool:chat:session-save", session })
  const nextVisit = await storefront(storage)
  nextVisit.receive({
    type: "datool:chat:session-request",
    requestId: "resume",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(nextVisit.frame.messages).toEqual([
    {
      type: "datool:chat:session-response",
      requestId: "resume",
      session,
      shopify: false,
    },
  ])
})

test("Shopify browser persistence never stores a customer access token and always reauthenticates through the store", async () => {
  const storage = new Map<string, string>()
  const calls: Record<string, unknown>[] = []
  const proxy = {
    path: "/apps/datool",
    respond: (body: Record<string, unknown>) => {
      calls.push(body)
      return {
        data: {
          visitorToken: "short-customer-access",
          browserToken: "browser-exchange-only",
          visitorId: "customer-a",
          conversationId: "private-thread",
        },
      }
    },
  }
  const first = await storefront(storage, "channel-one", proxy)
  first.receive({ type: "datool:chat:session-request", requestId: "first" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    [...storage.values()].some((value) =>
      value.includes("short-customer-access")
    )
  ).toBe(false)
  const nextVisit = await storefront(storage, "channel-one", proxy)
  nextVisit.receive({ type: "datool:chat:session-request", requestId: "next" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls.length).toBe(2)
  expect(calls[1].browserToken).toBe("browser-exchange-only")
  const reply = nextVisit.frame.messages[0] as {
    session: Record<string, unknown>
  }
  expect(reply.session.browserToken).toBeUndefined()
  expect(reply.session.visitorToken).toBe("short-customer-access")
})

test("storefront cart bridge uses the current cart, strips private fields and never replays uncertain or duplicate writes", async () => {
  const storage = new Map<string, string>()
  const requests: Array<{ url: string; body: unknown }> = []
  let quantity = 0
  let loseReply = false
  let lineDetails: Record<string, unknown> = {
    properties: { secret: "private" },
  }
  const snapshot = () => ({
    token: "private-cart-checkout-token",
    note: "private note",
    attributes: { email: "private@example.test" },
    currency: "BRL",
    total_price: quantity * 2500,
    item_count: quantity,
    items: quantity
      ? [
          {
            key: "123:line",
            variant_id: 123,
            product_title: "Board wax",
            quantity,
            final_line_price: quantity * 2500,
            url: "/products/wax?variant=123",
            ...lineDetails,
          },
        ]
      : [],
  })
  const proxy = {
    path: "/apps/datool",
    respond: () => ({
      data: {
        visitorId: "shopper",
        conversationId: "thread",
        browserToken: "private-browser-token",
        visitorToken: "public-session",
      },
    }),
  }
  const cart = {
    respond: async (url: string, body?: string) => {
      const data = body ? JSON.parse(body) : undefined
      requests.push({ url, body: data })
      if (url.endsWith("/cart/add.js")) quantity += data.items[0].quantity
      if (url.endsWith("/cart/change.js")) quantity = data.quantity
      if (body && loseReply) throw new Error("Reply lost after write")
      return Response.json(snapshot())
    },
  }
  const page = await storefront(storage, "channel-one", proxy, cart)
  page.receive({ type: "datool:chat:session-request", requestId: "identity" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const input = {
    type: "datool:shopify:cart-request",
    requestId: "add",
    operationId: "operation-0000000001",
    visitorId: "shopper",
    expiresAt: Date.now() + 60_000,
    command: { operation: "add", items: [{ variantId: "123", quantity: 2 }] },
  }
  page.receive(input, {})
  page.receive(input, page.frame.contentWindow, "https://evil.test")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toHaveLength(0)
  page.receive(input)
  page.receive(input)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(quantity).toBe(2)
  expect(requests.filter((request) => request.body)).toEqual([
    {
      url: "https://store.example/pt-br/cart/add.js",
      body: { items: [{ id: "123", quantity: 2 }] },
    },
  ])
  const messages = page.frame.messages as Array<{
    type: string
    result?: { status: string; cart?: unknown }
  }>
  const result = messages
    .filter((message) => message.type === "datool:shopify:cart-response")
    .at(-1)!.result
  expect(result).toMatchObject({
    status: "completed",
    cart: {
      currency: "BRL",
      itemCount: 2,
      totalPrice: 5000,
      requiresStoreCheckout: true,
      checkoutUrl: "https://store.example/pt-br/checkout",
    },
  })
  expect(JSON.stringify(result)).not.toContain("private")
  expect(page.events).toHaveLength(1)
  const otherTab = await storefront(storage, "channel-one", proxy, cart)
  otherTab.receive({
    type: "datool:chat:session-request",
    requestId: "identity2",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  otherTab.receive(input)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(quantity).toBe(2)
  for (const [details, requiresStoreCheckout] of [
    [
      {
        selling_plan_allocation: {
          selling_plan: { id: 123, name: "private subscription" },
        },
      },
      true,
    ],
    [{ has_components: true }, true],
    [{ parent_relationship: { parent_key: "private-parent" } }, true],
    [{ properties: {} }, false],
  ] as const) {
    lineDetails = details
    page.receive({ ...input, command: { operation: "read" } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const result = page.frame.messages.at(-1) as {
      result: { cart: { requiresStoreCheckout: boolean } }
    }
    expect(result.result.cart.requiresStoreCheckout).toBe(requiresStoreCheckout)
    expect(JSON.stringify(result)).not.toContain("private")
  }
  page.receive({
    ...input,
    operationId: "operation-0000000002",
    command: { operation: "set", lineKey: "123:line", quantity: 0 },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(quantity).toBe(0)
  expect(requests.filter((request) => request.body).at(-1)).toEqual({
    url: "https://store.example/pt-br/cart/change.js",
    body: { id: "123:line", quantity: 0 },
  })
  loseReply = true
  const uncertain = { ...input, operationId: "operation-0000000003" }
  page.receive(uncertain)
  await new Promise((resolve) => setTimeout(resolve, 5))
  otherTab.receive(uncertain)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(quantity).toBe(2)
  expect(
    (otherTab.frame.messages.at(-1) as { result: { status: string } }).result
      .status
  ).toBe("uncertain")
  const writes = requests.filter((request) => request.body).length
  for (const rejected of [
    { ...input, visitorId: "other-shopper" },
    {
      ...input,
      operationId: "operation-0000000004",
      expiresAt: Date.now() - 1,
    },
    {
      ...input,
      operationId: "operation-0000000005",
      command: { operation: "fetch", url: "https://evil.test" },
    },
    {
      ...input,
      operationId: "operation-0000000006",
      command: {
        operation: "add",
        items: [{ variantId: "123", quantity: -1 }],
      },
    },
  ])
    page.receive(rejected)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(requests.filter((request) => request.body)).toHaveLength(writes)
})

import { expect, test } from "bun:test"
import { createDatoolClient } from "../packages/sdk/src/agents"
import { createDatoolHandler } from "../packages/react/src/server"

const connectionId = "ab603abe-521a-4eb9-920d-eef60f1dce93"
const options = {
  apiKey: "dtk_server_secret",
  projectId: "project",
  connectionId,
  baseUrl: "https://datool.example",
}
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.example/api/datool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example",
      ...headers,
    },
    body: JSON.stringify(body),
  })

test("route authenticates every request and never accepts a browser-selected identity or drive", async () => {
  const upstream: Array<{
    url: string
    body: Record<string, unknown>
    headers: Headers
  }> = []
  let orgId = "alpha"
  let authCalls = 0
  const handler = createDatoolHandler({
    ...options,
    config: async () => {
      authCalls++
      return { userId: "user", drive: `drive_${orgId}` }
    },
    fetch: (async (url, init) => {
      upstream.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      })
      return Response.json({ data: { conversationId: "conversation" } })
    }) as typeof fetch,
  })
  const first = await handler(request({ action: "session" }))
  expect(first.status).toBe(200)
  expect(await first.text()).not.toContain(options.apiKey)
  expect(upstream[0].body).toMatchObject({
    userId: "user",
    drive: "drive_alpha",
    connectionId,
  })
  expect(upstream[0].headers.get("authorization")).toBe(
    `Bearer ${options.apiKey}`
  )
  orgId = "beta"
  await handler(request({ action: "messages", conversationId: "conversation" }))
  expect(authCalls).toBe(2)
  expect(upstream[1].body.drive).toBe("drive_beta")
  expect(
    (
      await handler(
        request({ action: "session", drive: "drive_alpha", userId: "victim" })
      )
    ).status
  ).toBe(400)
  expect(upstream).toHaveLength(2)
  expect(
    (
      await handler(
        request({ action: "session" }, { origin: "https://attacker.example" })
      )
    ).status
  ).toBe(403)
})

test("anonymous app visitors use signed cookies and tampering cannot select another visitor", async () => {
  const identities: string[] = []
  const handler = createDatoolHandler({
    ...options,
    config: () => ({ drive: "org" }),
    fetch: (async (_url, init) => {
      identities.push(JSON.parse(String(init?.body)).userId)
      return Response.json({ data: { conversationId: "conversation" } })
    }) as typeof fetch,
  })
  const first = await handler(request({ action: "session" }))
  const cookie = first.headers.get("set-cookie")!
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("Secure")
  await handler(
    request({ action: "session" }, { cookie: cookie.split(";")[0] })
  )
  expect(identities[1]).toBe(identities[0])
  await handler(
    request(
      { action: "session" },
      { cookie: cookie.split(";")[0] + "tampered" }
    )
  )
  expect(identities[2]).not.toBe(identities[0])
})

test("route fails closed on authentication, oversized bodies and non-chat operations", async () => {
  let called = false
  const transport = (async () => {
    called = true
    return Response.json({})
  }) as typeof fetch
  const denied = createDatoolHandler({
    ...options,
    config: () => {
      throw new Error("private auth failure")
    },
    fetch: transport,
  })
  const result = await denied(request({ action: "session" }))
  expect(result.status).toBe(401)
  expect(await result.text()).not.toContain("private auth failure")
  const handler = createDatoolHandler({
    ...options,
    config: () => ({ userId: "user" }),
    fetch: transport,
  })
  expect(
    (await handler(request({ action: "delete", path: "private" }))).status
  ).toBe(400)
  expect(
    (await handler(request({ action: "send", text: "x".repeat(100_001) })))
      .status
  ).toBe(413)
  expect(called).toBe(false)
})

test("server client shares one scoped conversation across messages and proactive tasks", async () => {
  const calls: Array<{
    url: string
    input: Record<string, unknown>
    key: string | null
  }> = []
  const client = createDatoolClient({
    ...options,
    fetch: (async (url, init) => {
      const input = JSON.parse(String(init?.body))
      calls.push({
        url: String(url),
        input,
        key: new Headers(init?.headers).get("idempotency-key"),
      })
      return Response.json({
        data:
          input.request.action === "session"
            ? { conversationId: "session" }
            : input.request.action === "read"
              ? { content: Buffer.from("Hello").toString("base64") }
              : {},
      })
    }) as typeof fetch,
  })
  const agent = client.agent({ connectionId, userId: "user", drive: "org" })
  await agent.messages.send("Hello", { requestId: connectionId })
  await agent.tasks.create({
    name: "Brief",
    prompt: "Send a briefing",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    timezone: "UTC",
  })
  await agent.files.write("context.md", "Hello")
  expect(await agent.files.read("context.md")).toBe("Hello")
  expect(
    calls.filter(
      (call) => (call.input.request as { action: string }).action === "session"
    )
  ).toHaveLength(1)
  expect(calls[1].key).toBe(connectionId)
  expect(calls[2].input.conversationId).toBe("session")
  for (const call of calls)
    expect(call.input).toMatchObject({
      connectionId,
      userId: "user",
      drive: "org",
    })
  expect(() =>
    createDatoolClient({ ...options, baseUrl: "http://example.com" })
  ).toThrow("HTTPS")
})

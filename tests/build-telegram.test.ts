import { afterEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"

import {
  createTelegramApi,
  normalizeTelegramUpdate,
  sendTelegramEnvelope,
} from "../src/server/build/channels/telegram"
import { redactConfig, timingSafeStringEquals } from "../src/lib/build/channels"
import { publicRequestClientKey } from "../src/server/build/channels/service"
import { signVisitorContext, verifyVisitorContext } from "../src/server/build/channels/visitor"

const originalFetch = globalThis.fetch
const originalSecret = process.env.BETTER_AUTH_SECRET

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = originalSecret
})

describe("Telegram channel protocol boundary", () => {
  test("normalizes a text update and media into the channel-neutral envelope", () => {
    const envelope = normalizeTelegramUpdate("connection-1", {
      update_id: 42,
      message: {
        message_id: 8,
        chat: { id: 100, type: "private" },
        from: { id: 200, first_name: "A", last_name: "User", username: "a_user", language_code: "en" },
        text: "hello",
        photo: [{ file_id: "small" }, { file_id: "large", width: 640, height: 480 }],
        document: { file_id: "doc", file_name: "guide.pdf", mime_type: "application/pdf" },
      },
    })
    expect(envelope).toMatchObject({
      connectionId: "connection-1",
      providerEventId: "42",
      providerMessageId: "8",
      externalConversationId: "100",
      externalContactId: "200",
      text: "hello",
      contact: { displayName: "A User", username: "a_user" },
    })
    expect(envelope?.attachments).toEqual([
      { type: "image", fileId: "large", metadata: { width: 640, height: 480 } },
      { type: "document", fileId: "doc", mimeType: "application/pdf", name: "guide.pdf" },
    ])
  })

  test("normalizes channel posts when Telegram supplies sender_chat instead of from", () => {
    const envelope = normalizeTelegramUpdate("connection-1", {
      update_id: 43,
      channel_post: {
        message_id: 9,
        chat: { id: -100, type: "channel", title: "Announcements" },
        sender_chat: { id: -100, type: "channel", title: "Announcements" },
        text: "New release",
      },
    })
    expect(envelope).toMatchObject({
      externalConversationId: "-100",
      externalContactId: "-100",
      text: "New release",
      contact: { displayName: "Announcements" },
    })
  })

  test("does not call Telegram for an unsupported webhook URL", async () => {
    const api = createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    expect(() => api.setWebhook({ url: "http://example.test/hook", secretToken: "secret" })).toThrow("HTTPS")
  })

  test("reports malformed credentials without treating them as a network failure", async () => {
    await assert.rejects(createTelegramApi("not-a-bot-token").getMe(), {
      code: "INVALID_CREDENTIAL",
      uncertain: false,
    })
  })

  for (const method of ["getMe", "deleteWebhook", "setWebhook"] as const)
    test(`recovers ${method} registration from a transient connection failure`, async () => {
      let attempts = 0
      globalThis.fetch = (async () => {
        if (++attempts === 1) throw new TypeError("Connection timed out")
        return Response.json({
          ok: true,
          result:
            method === "getMe"
              ? { id: 123456, is_bot: true, first_name: "Support" }
              : true,
        })
      }) as typeof fetch
      const api = createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      const result =
        method === "setWebhook"
          ? await api.setWebhook({
              url: "https://example.test/hook",
              secretToken: "secret",
            })
          : await api[method]()
      if (method === "getMe")
        expect(result).toMatchObject({ id: 123456, is_bot: true })
      else expect(result).toBe(true)
      expect(attempts).toBe(2)
    })

  test("bounds registration retries when Telegram remains unreachable", async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      throw new TypeError("Connection timed out")
    }) as typeof fetch
    await assert.rejects(
      createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").getMe(),
      { code: "NETWORK_ERROR" }
    )
    expect(attempts).toBe(3)
  })

  test("does not retry a rejected token or a webhook change that discards pending messages", async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      return Response.json(
        { ok: false, error_code: 401, description: "Unauthorized" },
        { status: 401 }
      )
    }) as typeof fetch
    await assert.rejects(
      createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").getMe(),
      { code: "INVALID_CREDENTIAL" }
    )
    expect(attempts).toBe(1)
    globalThis.fetch = (async () => {
      attempts++
      throw new TypeError("Connection timed out")
    }) as typeof fetch
    const api = createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    await assert.rejects(api.deleteWebhook(true), { code: "NETWORK_ERROR" })
    await assert.rejects(
      api.setWebhook({
        url: "https://example.test/hook",
        secretToken: "secret",
        dropPendingUpdates: true,
      }),
      { code: "NETWORK_ERROR" }
    )
    expect(attempts).toBe(3)
  })

  for (const payload of [null, { ok: true }])
    test(`sanitizes malformed Telegram responses (${JSON.stringify(payload)})`, async () => {
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch
      await assert.rejects(
        createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").getMe(),
        {
          code: "INVALID_PROVIDER_RESPONSE",
          uncertain: false,
        }
      )
    })

  for (const { status, code, uncertain } of [
    { status: 401, code: "INVALID_CREDENTIAL", uncertain: false },
    { status: 429, code: "RATE_LIMITED", uncertain: false },
    { status: 502, code: "PROVIDER_ERROR", uncertain: true },
  ])
    test(`classifies Telegram ${status} without exposing credentials or message content`, async () => {
      const token = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      globalThis.fetch = (async () =>
        Response.json(
          {
            ok: false,
            error_code: status,
            description: `Provider error containing ${token} and private message`,
            parameters: { retry_after: 12 },
          },
          { status }
        )) as typeof fetch
      await assert.rejects(
        createTelegramApi(token).sendMessage("7", "private message"),
        (error: unknown) => {
          expect(error).toMatchObject({
            code,
            status,
            uncertain,
            retryAfterSeconds: 12,
          })
          expect(String(error)).not.toContain(token)
          expect(JSON.stringify(error)).not.toContain("private message")
          return true
        }
      )
    })

  test("keeps network failures uncertain for sends without exposing the token-bearing URL", async () => {
    const token = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      throw new Error(
        `fetch https://api.telegram.org/bot${token}/sendMessage failed`
      )
    }) as typeof fetch
    await assert.rejects(
      createTelegramApi(token).sendMessage("7", "private message"),
      (error: unknown) => {
        expect(error).toMatchObject({ code: "NETWORK_ERROR", uncertain: true })
        expect(String(error)).not.toContain(token)
        expect(JSON.stringify(error)).not.toContain(token)
        return true
      }
    )
    expect(attempts).toBe(1)
  })

  test("sends bounded text chunks and supported media without leaking provider errors", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      requests.push({ url: String(input), body })
      return Response.json({ ok: true, result: { message_id: requests.length, chat: { id: 7 } } })
    }) as typeof fetch
    const api = createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    const ids = await sendTelegramEnvelope(api, {
      connectionId: "connection-1",
      conversationId: "conversation-1",
      channel: "telegram",
      idempotencyKey: "reply-1",
      text: "x".repeat(4_100),
      attachments: [{ type: "image", fileId: "photo-id" }],
    }, "7")
    expect(ids).toEqual(["1", "2", "3"])
    expect(requests).toHaveLength(3)
    expect(requests[0]?.body.text).toHaveLength(4096)
    expect(requests[2]?.body.photo).toBe("photo-id")
    expect(requests[0]?.url).not.toContain("[redacted]")
  })

  test("marks a partial Telegram send uncertain instead of replaying earlier parts", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } })
      return Response.json({ ok: false, error_code: 429, description: "retry later" }, { status: 429 })
    }) as typeof fetch

    const api = createTelegramApi("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    await assert.rejects(
      sendTelegramEnvelope(api, {
        connectionId: "connection-1",
        conversationId: "conversation-1",
        channel: "telegram",
        idempotencyKey: "partial-1",
        text: "x".repeat(4_100),
      }, "7"),
      (error: unknown) => {
        expect(error).toMatchObject({ code: "RATE_LIMITED", uncertain: true })
        return true
      },
    )
    expect(calls).toBe(2)
  })
})

describe("public channel visitor and webhook authentication", () => {
  test("uses one anonymous admission bucket when proxy identity is unavailable", () => {
    const first = new Request("https://datool.test/api/build-public/connection/session", {
      headers: { origin: "https://first-caller.example" },
    })
    const rotated = new Request("https://datool.test/api/build-public/connection/session", {
      headers: { origin: "https://rotated-caller.example" },
    })
    expect(publicRequestClientKey(first)).toBe("anonymous")
    expect(publicRequestClientKey(rotated)).toBe("anonymous")
  })

  test("uses a validated proxy IP only when the trusted proxy switch is enabled", () => {
    const previous = process.env.DATOOL_TRUSTED_PROXY
    process.env.DATOOL_TRUSTED_PROXY = "true"
    try {
      expect(publicRequestClientKey(new Request("https://datool.test", { headers: { "x-real-ip": "192.0.2.10", origin: "https://one.example" } }))).toBe("ip:192.0.2.10")
      expect(publicRequestClientKey(new Request("https://datool.test", { headers: { "x-real-ip": "192.0.2.11", origin: "https://one.example" } }))).toBe("ip:192.0.2.11")
    } finally {
      if (previous === undefined) delete process.env.DATOOL_TRUSTED_PROXY
      else process.env.DATOOL_TRUSTED_PROXY = previous
    }
  })

  test("rejects forged visitor and webhook signatures", () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(64)
    const token = signVisitorContext({ visitorId: "visitor-1", connectionId: "connection-a", origin: "https://example.test" }, 100)
    expect(verifyVisitorContext(token, { origin: "https://example.test", connectionId: "connection-a", now: 101 }).visitorId).toBe("visitor-1")
    expect(() => verifyVisitorContext(`${token.slice(0, -1)}x`, { origin: "https://example.test", now: 101 })).toThrow("Invalid visitor context")
    expect(() => verifyVisitorContext(token, { origin: "https://other.test", now: 101 })).toThrow("origin")
    expect(() => verifyVisitorContext(token, { connectionId: "connection-b", now: 101 })).toThrow("connection")
    const unbound = signVisitorContext({ visitorId: "visitor-2", connectionId: "connection-a" }, 100)
    expect(() => verifyVisitorContext(unbound, { origin: "https://example.test", now: 101 })).toThrow("origin")
    expect(timingSafeStringEquals("secret", "secret")).toBe(true)
    expect(timingSafeStringEquals("secret", "forged")).toBe(false)
  })

  test("redacts nested provider credentials in public config views", () => {
    expect(redactConfig({
      originAllowlist: ["https://example.test"],
      provider: { cookie: "session-cookie", tls: { privateKey: "pem" } },
      metadata: [{ authorization: "bearer" }, { label: "safe" }],
    })).toEqual({
      originAllowlist: ["https://example.test"],
      provider: { cookie: "[redacted]", tls: { privateKey: "[redacted]" } },
      metadata: [{ authorization: "[redacted]" }, { label: "safe" }],
    })
  })
})

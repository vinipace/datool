import { describe, test } from "bun:test"
import assert from "node:assert/strict"
import { publicHttpRequest } from "../src/server/build/http"

describe("public Build HTTP boundary", () => {
  test("rejects private destinations and URL disguises before opening a connection", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2002:7f00:1::]/",
      "http://localhost/",
      "http://db.internal/",
      "file:///etc/passwd",
      "https://username:password@example.com/",
    ])
      await assert.rejects(publicHttpRequest(url))
  })

  test("rejects oversized customer input before any network request", async () => {
    await assert.rejects(
      publicHttpRequest("https://example.com/", {
        method: "POST",
        body: "12345",
        maxRequestBytes: 4,
      }),
      /size limit/
    )
  })

  test("honors a cancelled customer request before DNS or delivery", async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      publicHttpRequest("https://example.com/", { signal: controller.signal }),
      /cancelled/
    )
  })
})

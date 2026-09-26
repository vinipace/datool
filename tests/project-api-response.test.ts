import { describe, expect, test } from "bun:test"

import { hasTrustedMutationOrigin, readJson } from "@/lib/api-response"

describe("project API request guards", () => {
  test("stops a streamed JSON body that exceeds its cap without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":"'))
        controller.enqueue(new TextEncoder().encode("x".repeat(64)))
        controller.enqueue(new TextEncoder().encode('"}'))
        controller.close()
      },
    })
    const request = new Request("http://localhost/api/projects/project_1/records", {
      method: "POST",
      body: stream,
    })

    expect(request.headers.get("content-length")).toBeNull()
    expect(await readJson(request, 32)).toEqual({ kind: "too-large" })
  })

  test("requires the configured Better Auth origin for cookie-based mutations", () => {
    const previousBaseUrl = process.env.BETTER_AUTH_URL
    process.env.BETTER_AUTH_URL = "https://app.example.test"

    try {
      const missingOrigin = new Request("https://app.example.test/api/projects/project_1", {
        method: "PATCH",
        headers: { cookie: "better-auth.session_token=session_1" },
      })
      const foreignOrigin = new Request("https://app.example.test/api/projects/project_1", {
        method: "PATCH",
        headers: { origin: "https://attacker.example.test", cookie: "better-auth.session_token=session_1" },
      })
      const trustedOrigin = new Request("https://app.example.test/api/projects/project_1", {
        method: "PATCH",
        headers: { origin: "https://app.example.test", cookie: "better-auth.session_token=session_1" },
      })

      expect(hasTrustedMutationOrigin(missingOrigin)).toBe(false)
      expect(hasTrustedMutationOrigin(foreignOrigin)).toBe(false)
      expect(hasTrustedMutationOrigin(trustedOrigin)).toBe(true)
    } finally {
      if (previousBaseUrl === undefined) delete process.env.BETTER_AUTH_URL
      else process.env.BETTER_AUTH_URL = previousBaseUrl
    }
  })
})

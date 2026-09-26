import { serveWebhook } from "../src/server/apps/webhook"
import assert from "node:assert/strict"
import { describe, expect, test } from "bun:test"
import {
  connectionSchema,
  invokeConnection,
  publicConnection,
} from "../src/server/apps/store"
describe("app connections", () => {
  test("rejects non-HTTP endpoints and hides credentials", () => {
    expect(
      connectionSchema.safeParse({
        name: "test",
        mode: "input",
        url: "file:///tmp/test",
      }).success
    ).toBe(false)
    expect(
      Object.hasOwn(
        publicConnection({
          id: "1",
          name: "test",
          mode: "input",
          url: "http://localhost",
          token: "secret",
        }),
        "token"
      )
    ).toBe(false)
  })
  test("forwards JSON input and authentication, and rejects a mismatched mode", async () => {
    const server = await serveWebhook(async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer secret")
      return Response.json({ received: await request.json() })
    })
    try {
      const app = {
        id: "1",
        name: "test",
        mode: "input" as const,
        url: `http://localhost:${server.port}`,
        token: "secret",
      }
      expect(await invokeConnection(app, { input: { value: 42 } })).toEqual({
        received: { input: { value: 42 } },
      })
      await assert.rejects(
        invokeConnection(app, {
          messages: [{ role: "user", content: "hello" }],
        }),
        /requires input/
      )
      await assert.rejects(invokeConnection(app, {}))
      expect(
        await invokeConnection(
          { ...app, mode: "agent" },
          { messages: [{ role: "user", content: "hello" }] }
        )
      ).toEqual({
        received: { messages: [{ role: "user", content: "hello" }] },
      })
    } finally {
      server.stop()
    }
  })
})

test("HTTP apps receive prompt run scope as headers, separate from case inputs", async () => {
  const { withDatoolRequest, getDatoolCallContext } =
    await import("../src/lib/tracer/call-context")
  const { createDatool } = await import("../src/lib/tracer/client")
  const client = createDatool({ apiKey: "fixture" })
  const server = await serveWebhook((request) =>
    withDatoolRequest(request, async () => {
      client.prompts.override("brand", { model: "scoped" })
      const scope = getDatoolCallContext()?.promptScope
      return Response.json({ scope, input: await request.json() })
    })
  )
  try {
    const promptScope = { projectId: "project", runId: "run" }
    const connection = {
      id: "http",
      name: "HTTP",
      mode: "input" as const,
      url: `http://127.0.0.1:${server.port}`,
    }
    expect(
      await invokeConnection(connection, { input: { value: 42 } }, "call", {
        traceId: "trace",
        promptScope,
      })
    ).toEqual({ scope: promptScope, input: { input: { value: 42 } } })
    expect(() => client.prompts.reset("brand")).toThrow("withScope")
    // The shared HTTP adapter (registered webhooks) uses the same scope headers.
    expect(
      await invokeConnection(
        {
          ...connection,
          target: {
            type: "webhook",
            config: {
              type: "webhook",
              url: connection.url,
              method: "POST",
              body: "input",
              timeoutMs: 5000,
            },
          },
        },
        { input: { value: 7 } },
        "call-two",
        { traceId: "trace-two", promptScope }
      )
    ).toEqual({ scope: promptScope, input: { value: 7 } })
  } finally {
    server.stop()
  }
})

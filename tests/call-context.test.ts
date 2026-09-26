import { describe, test, expect } from "bun:test"
import {
  withDatoolCall,
  withDatoolRequest,
  datoolCallAttributes,
} from "../src/lib/tracer/call-context"
import { DatoolSpanProcessor } from "../src/lib/tracer/otel"
import { compileCollectionFilter } from "../src/lib/tracer/collection-filters"

describe("playground trace correlation", () => {
  test("isolates concurrent calls and preserves start context when spans end outside it", async () => {
    const exports: {
      path: string
      body: { id?: string; attributes: Record<string, string> }
    }[] = []
    const processor = new DatoolSpanProcessor({ pricing: { autoRefresh: false }, delivery: "direct",
      apiKey: "test",
      fetch: async (url, init) => {
        exports.push({
          path: new URL(String(url)).pathname,
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ data: {} })
      },
    })
    const spans = await Promise.all(
      ["first", "second"].map((callId, index) =>
        withDatoolCall({ connectionId: "app", callId }, async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, index === 0 ? 10 : 1)
          )
          expect(datoolCallAttributes()["datool.call.id"]).toBe(callId)
          const span = {
            name: "test",
            attributes: {},
            startTime: [1, 0] as [number, number],
            status: { code: index === 0 ? 2 : 1 },
            spanContext: () => ({ spanId: callId, traceId: callId }),
          }
          processor.onStart(span)
          return span
        })
      )
    )
    expect(datoolCallAttributes()["datool.call.id"]).toBeUndefined()
    spans.forEach((span) => processor.onEnd(span))
    await processor.forceFlush()
    for (const callId of ["first", "second"]) {
      const start = exports.find(
        (item) => item.path === "/api/traces" && item.body.id === callId
      )!
      const end = exports.find((item) => item.path === `/api/traces/${callId}`)!
      expect(start.body.attributes["datool.call.id"]).toBe(callId)
      expect(end.body.attributes["datool.call.id"]).toBe(callId)
      expect(end.body.attributes["datool.connection.id"]).toBe("app")
      const filter = compileCollectionFilter(
        "traces",
        `metadata."datool.connection.id" = "app" metadata."datool.call.id" = "${callId}"`
      )
      expect(filter(end.body)).toBe(true)
    }
  })
  test("HTTP helper captures headers and leaves unrelated requests untagged", () => {
    const request = new Request("http://localhost", {
      headers: {
        "x-datool-connection-id": "http-app",
        "x-datool-call-id": "call",
      },
    })
    expect(withDatoolRequest(request, datoolCallAttributes)).toEqual({
      "datool.connection.id": "http-app",
      "datool.call.id": "call",
    })
    expect(
      withDatoolRequest(new Request("http://localhost"), datoolCallAttributes)[
        "datool.call.id"
      ]
    ).toBeUndefined()
  })
})

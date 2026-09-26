import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { DatoolClient } from "../src/lib/tracer/client"
import { createTracer } from "../src/lib/tracer/sdk"
import type { QueuedEvent } from "../src/lib/tracer/queued-request"
import { IngestionSequence } from "../src/lib/tracer/ingestion-sequence"

const accepted = () => Response.json({ data: { status: "queued" } }, { status: 202 })

test("exhausted delivery retries preserve all events and resend the original predecessor before successors", async () => {
  const sent: QueuedEvent[] = []
  let unavailable = true
  const client = new DatoolClient({ apiKey: "test", retries: 0, fetch: (async (_url, init) => {
    const event = JSON.parse(String(init?.body)) as QueuedEvent
    sent.push(event)
    return unavailable ? new Response(null, { status: 503 }) : accepted()
  }) as typeof fetch })
  const first = { id: "first", name: "before outage" }
  await rejects(client.request("/api/traces", "POST", first), /503/)
  first.name = "mutated after failure"
  await rejects(client.request("/api/traces", "POST", { id: "second" }), /503/)
  expect(sent[0]).toEqual(sent[1])
  unavailable = false
  await client.request("/api/traces", "POST", { id: "third" })
  expect(sent).toHaveLength(5)
  expect(sent[2]).toEqual(sent[0])
  expect(sent[3].previousId).toBe(sent[2].id)
  expect(sent[4].previousId).toBe(sent[3].id)
  expect(sent.slice(2).map(event => (event.body as {id:string}).id)).toEqual(["first", "second", "third"])
})

test("concurrent delivery waits for acknowledgement and flush retries an ambiguous response with the same ID", async () => {
  const sent: QueuedEvent[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const client = new DatoolClient({ apiKey: "test", retries: 0, fetch: (async (_url, init) => {
    if (init?.method === "GET") return Response.json({ data: { status: "saved" } })
    sent.push(JSON.parse(String(init?.body)))
    if (++calls === 1) { await waiting; throw new TypeError("connection lost after acceptance") }
    return accepted()
  }) as typeof fetch })
  const first = client.request("/api/traces", "POST", { id: "first" })
  const rejected = first.then(() => { throw new Error("Expected delivery failure") }, error => {
    expect(error.message).toContain("transport retries")
  })
  const second = client.request("/api/traces", "POST", { id: "second" })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(sent).toHaveLength(1)
  release()
  await rejected
  await second
  await client.forceFlush()
  expect(sent).toHaveLength(3)
  expect(sent[0]).toEqual(sent[1])
  expect(sent[2].previousId).toBe(sent[0].id)
})

test("forceFlush recovers a final unacknowledged event before waiting for its receipt", async () => {
  const sent: QueuedEvent[] = []
  let finalId = ""
  const client = new DatoolClient({ apiKey: "test", retries: 0, fetch: (async (url, init) => {
    if (init?.method === "GET") {
      expect(String(url)).toContain(finalId)
      return Response.json({ data: { status: "saved" } })
    }
    const event = JSON.parse(String(init?.body)) as QueuedEvent
    sent.push(event); finalId = event.id
    return sent.length === 1 ? new Response(null, {status:503}) : accepted()
  }) as typeof fetch })
  await rejects(client.request("/api/traces", "POST", { id: "final" }))
  await client.forceFlush()
  expect(sent[0]).toEqual(sent[1])
})

test("manual tracer replays a lost predecessor without changing its event or payload", async () => {
  const sent: QueuedEvent[] = []
  const tracer = createTracer({ apiKey: "test", retries: 0, fetch: async (_url, init) => {
    if (init?.method === "GET") return Response.json({ data: { status: "saved", result: sent.at(-1)!.body } })
    sent.push(JSON.parse(String(init?.body)))
    return sent.length === 1 ? new Response(null, { status: 503 }) : accepted()
  } })
  await rejects(tracer.startTrace({ id: "first", name: "first" }), /503/)
  const next = await tracer.startTrace({ id: "second", name: "second" })
  expect(next.id).toBe("second")
  expect(sent[0]).toEqual(sent[1])
  expect(sent[2].previousId).toBe(sent[0].id)
})

test("an unavailable transport has a bounded buffer and releases capacity after recovery", async () => {
  let unavailable = true
  const saved: QueuedEvent[] = []
  const sequence = new IngestionSequence(async event => {
    if (unavailable) throw new Error("unavailable")
    saved.push(event)
  })
  for (let i = 0; i < 1000; i++) {
    await rejects(sequence.request({ path: "/api/traces", method: "POST", body: {id:i} }), /unavailable/)
  }
  await rejects(sequence.request({path:"/api/traces",method:"POST",body:{id:"overflow"}}), /buffer is full/)
  unavailable = false
  await sequence.flush()
  expect(saved).toHaveLength(1000)
  await sequence.request({path:"/api/traces",method:"POST",body:{id:"after recovery"}})
  expect(saved[1000].previousId).toBe(saved[999].id)
})

test("flush does not consume a request submitted after its boundary", async () => {
  const sent: QueuedEvent[] = []
  const sequence = new IngestionSequence(async event => { sent.push(event); return event.body })
  const first = sequence.request({path:"/api/traces",method:"POST",body:{id:"first"}})
  const flushed = sequence.flush()
  const second = sequence.request({path:"/api/traces",method:"POST",body:{id:"second"}})
  expect(await first).toEqual({id:"first"})
  await flushed
  expect(await second).toEqual({id:"second"})
  expect(sent).toHaveLength(2)
  expect(sent[1].previousId).toBe(sent[0].id)
})

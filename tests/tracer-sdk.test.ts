import { describe, expect, test } from "bun:test"

import { runDemoWorkflow } from "@/src/lib/tracer/demo"
import { createTracer } from "@/src/lib/tracer/sdk"

type RecordedRequest = {
  body: Record<string, unknown>
  method: string
  path: string
}

function createRecordingTracer() {
  const requests: RecordedRequest[] = []
  let tick = 0
  const tracer = createTracer({
    delivery: "direct",
    baseUrl: "http://datool.test",
    clock: () => new Date(Date.UTC(2026, 8, 6, 12, 0, tick++)),
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >
      const method = init?.method ?? "GET"
      requests.push({ body, method, path })

      let data: Record<string, unknown>
      if (path === "/api/sessions") {
        data = {
          attributes: body.attributes ?? {},
          createdAt: "2026-09-06T12:00:00.000Z",
          id: body.id,
          name: body.name ?? null,
          traceCount: 0,
          updatedAt: "2026-09-06T12:00:00.000Z",
        }
      } else if (path === "/api/traces") {
        data = {
          attributes: body.attributes ?? {},
          durationMs: null,
          endedAt: null,
          id: body.id,
          input: body.input ?? null,
          name: body.name ?? "trace",
          operation: body.operation ?? "workflow",
          output: null,
          sessionId: body.sessionId ?? null,
          startedAt: body.startedAt,
          status: body.status,
        }
      } else if (path.includes("/spans")) {
        const traceId = path.split("/")[3]
        data = {
          attributes: body.attributes ?? {},
          durationMs: null,
          endedAt: null,
          id: body.id,
          input: body.input ?? null,
          kind: body.kind ?? "custom",
          name: body.name ?? "span",
          output: null,
          parentId: body.parentId ?? null,
          startedAt: body.startedAt,
          status: body.status,
          traceId,
        }
      } else {
        data = { id: path.split("/").at(-1), ...body }
      }

      return new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    },
  })

  return { requests, tracer }
}

describe("Node tracer SDK", () => {
  test("posts trace and nested span lifecycle updates immediately", async () => {
    const { requests, tracer } = createRecordingTracer()
    const session = await tracer.createSession({
      attributes: { demo: true },
      name: "SDK test",
    })

    await tracer.withSession(session.id, async () => {
      await tracer.trace(
        {
          input: { question: "Where is the source?" },
          name: "Review workflow",
          operation: "review.workflow",
        },
        async (trace) => {
          return trace.span(
            {
              input: { query: "source" },
              kind: "agent",
              name: "Find source",
            },
            async () =>
              trace.span({ kind: "tool", name: "Read source" }, async () => ({
                answer: { text: "The source is linked." },
              }))
          )
        }
      )
    })

    expect(
      requests.map((request) => `${request.method} ${request.path}`)
    ).toEqual([
      "POST /api/sessions",
      "POST /api/traces",
      "POST /api/traces/tr_" + String(requests[1]?.body.id).slice(3) + "/spans",
      "POST /api/traces/tr_" + String(requests[1]?.body.id).slice(3) + "/spans",
      "PATCH /api/spans/" + String(requests[3]?.body.id),
      "PATCH /api/spans/" + String(requests[2]?.body.id),
      "PATCH /api/traces/" + String(requests[1]?.body.id),
    ])

    const createdTrace = requests[1]?.body
    const createdOuterSpan = requests[2]?.body
    const createdInnerSpan = requests[3]?.body
    const endedTrace = requests[6]?.body

    expect(createdTrace?.status).toBe("running")
    expect(createdTrace?.sessionId).toBe(session.id)
    expect(createdOuterSpan?.parentId).toBeUndefined()
    expect(createdInnerSpan?.parentId).toBe(createdOuterSpan?.id)
    expect(endedTrace?.status).toBe("completed")
    expect(endedTrace?.output).toEqual({
      answer: { text: "The source is linked." },
    })
  })

  test("records an errored trace before rethrowing workflow failures", async () => {
    const { requests, tracer } = createRecordingTracer()
    let caught: unknown

    try {
      await tracer.trace(
        { name: "Broken workflow", operation: "broken.workflow" },
        async () => {
          throw new Error("upstream unavailable")
        }
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const patch = requests.at(-1)
    expect(patch?.method).toBe("PATCH")
    expect(patch?.path.startsWith("/api/traces/")).toBe(true)
    expect(patch?.body.status).toBe("errored")
    expect(patch?.body.attributes).toMatchObject({
      "error.message": "upstream unavailable",
      "error.name": "Error",
    })
  })

  test("preserves named workflow/agent identity and recorded cost through failures", async () => {
    const { requests, tracer } = createRecordingTracer()
    let failure: unknown
    try {
      await tracer.workflow(
        { name: "Onboarding", attributes: { tenant: "test" } },
        async (workflow) => {
          return workflow.agent(
            { name: "Reviewer", attributes: { version: "v1" } },
            async (agent) => {
              await agent.recordCost(0.25)
              throw new Error("provider failed")
            }
          )
        }
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("provider failed")
    const spanEnd = requests.find(
      (request) =>
        request.path.startsWith("/api/spans/") &&
        request.body.status === "errored"
    )
    expect(spanEnd?.body.attributes).toMatchObject({
      "cost.usd": 0.25,
      version: "v1",
      "error.message": "provider failed",
    })
    expect(requests.at(-1)?.body.attributes).toMatchObject({
      tenant: "test",
      "error.message": "provider failed",
    })
    expect(
      requests.find(
        (request) =>
          (request.body.attributes as Record<string, unknown>)?.["cost.usd"] ===
            0.25 && !request.body.status
      )?.body.endedAt
    ).toBeUndefined()
  })

  test("names nested agents and workflows while retaining parent context and validates costs", async () => {
    const { requests, tracer } = createRecordingTracer()
    await tracer.workflow({ name: "Root" }, async (workflow) => {
      return workflow.workflow({ name: "Nested" }, async () => {
        return tracer.agent({ name: "Helper" }, async (agent) => {
          expect(() => agent.recordCost(-1)).toThrow("nonnegative")
          expect(() => agent.recordCost(Number.NaN)).toThrow("nonnegative")
          await agent.recordCost(0)
          return { ok: true }
        })
      })
    })
    const created = requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/spans")
    )
    expect(created[0]?.body.kind).toBe("workflow")
    expect(created[1]?.body.parentId).toBe(created[0]?.body.id)
    expect(created[1]?.body.group).toEqual({ type: "agent", name: "Helper" })
    expect(() => tracer.agent({ name: "Missing trace" }, () => null)).toThrow(
      "inside"
    )
    expect(() => tracer.workflow({ name: " " }, () => null)).toThrow("empty")
  })

  test("captures the deterministic demo workflow as two nested live traces", async () => {
    const { requests, tracer } = createRecordingTracer()
    const result = await runDemoWorkflow(tracer)
    const createdTraces = requests.filter(
      (request) => request.method === "POST" && request.path === "/api/traces"
    )
    const createdSpans = requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/spans")
    )

    expect(result.traceIds).toHaveLength(2)
    expect(result.dataset.items).toHaveLength(2)
    expect(createdTraces).toHaveLength(2)
    expect(createdSpans).toHaveLength(8)
    expect(
      createdTraces.every((trace) => trace.body.status === "running")
    ).toBe(true)
    expect(
      createdTraces.every(
        (trace) =>
          (trace.body.attributes as Record<string, unknown>).demo === true &&
          (trace.body.input as Record<string, unknown>).question ===
            "What must be checked before an account launch?"
      )
    ).toBe(true)
    expect(result.view.columns.map((column) => column.selector)).toEqual([
      "result.score",
      "result.passed",
      "result.reasoning",
      "result.metadata.label",
      "result.metadata.metrics.answerLength",
      "trace.output.answer.text",
    ])
    expect(result.view.columns.map((column) => column.selector)).not.toContain(
      "trace.output"
    )
  })
})

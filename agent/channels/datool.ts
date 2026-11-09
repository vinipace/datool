import { timingSafeEqual } from "node:crypto"
import { defineChannel, POST } from "eve/channels"
import { contextForProject, synchronizeExecution, bindEveSession, getEveExecution } from "@datool/eve-bridge"
import type { MessageContent } from "eve/channels"

function authorized(request: Request) {
  const secret = process.env.DATOOL_EVE_SECRET
  if (!secret || secret.length < 32) return false
  const actual = Buffer.from(request.headers.get("authorization") ?? "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export default defineChannel({
  turnPolicy: "queue",
  routes: [POST("/datool/executions/:projectId/:turnId/:operation", async (request, { params, from, resolveSession, attachSession }) => {
    if (!authorized(request)) return new Response(null, { status: 401 })
    const context = contextForProject(params.projectId)
    const run = await getEveExecution(context, params.turnId).catch(() => null)
    if (!run) return new Response(null, { status: 404 })
    const address = `${run.projectId}:${run.turnId}`
    if (params.operation === "execute") {
      const messages = run.plan.messages
      const userIndex = messages.findLastIndex(message => message.role === "user")
      const latest = messages[userIndex]
      // Authenticated channel images are added at the provider boundary. Keeping
      // Eve's history textual avoids requiring an unrelated file sandbox.
      const message: MessageContent = typeof latest?.content === "string" ? latest.content : run.plan.inputText
      const history = messages.filter((item, index) => index !== userIndex && (item.role === "user" || item.role === "assistant")).map(item => ({
        role: item.role as "user" | "assistant", text: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
      })).filter(item => item.text.trim())
      const delivery = await from(address).send(message, {
        auth: { authenticator: "datool", principalType: "service", principalId: run.projectId, attributes: { projectId: run.projectId, turnId: run.turnId } },
        history, idempotencyKey: run.turnId,
      })
      await bindEveSession(context, run.turnId, delivery.sessionId)
      return Response.json({ sessionId: delivery.sessionId }, { status: 202 })
    }
    const session = run.sessionId ? attachSession(run.sessionId) : await resolveSession(address)
    if (!session) return new Response(null, { status: 409 })
    if (params.operation === "cancel") {
      await session.cancel()
      return Response.json({ sessionId: session.id })
    }
    if (params.operation !== "result") return new Response(null, { status: 404 })
    await synchronizeExecution(context, run.turnId, session.stream({ follow: false }))
    return Response.json({ sessionId: session.id })
  })],
})

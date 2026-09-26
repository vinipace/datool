import { workspaceIdentity } from "@/src/server/auth/context"
import { beginInvocation, executeInvocation, resolveApp } from "@/src/server/apps/invoke"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { playgroundSchema, type Attempt } from "@/src/lib/playground/contracts"
import { resolveNode, validateGraph } from "@/src/lib/playground/resolve"
import { mutate, readState, liveBridge, type State } from "./storage"
import { validateSchema } from "./schema"
import { getTracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"

function detail(state: State, id: string) {
  const playground = state.playgrounds.find((p) => p.id === id)
  if (!playground) throw new Error("Playground not found")
  return {
    playground,
    attempts: state.attempts.filter((a) => a.playgroundId === id),
  }
}
export async function getDetail(id: string) {
  return detail(await readState(), id)
}
export async function createPlayground(value: unknown) {
  const parsed = playgroundSchema.parse(value)
  validateGraph(parsed.nodes)
  return mutate((state) => {
    if (parsed.nodes.some((n) => !state.apps.some((a) => a.id === n.appId)))
      throw new Error("Register apps before adding nodes")
    if (parsed.nodes.some((n) => n.selectedAttemptId))
      throw new Error("New nodes cannot select existing attempts")
    const playground = { ...parsed, id: randomUUID(), revision: 1 }
    state.playgrounds.push(playground)
    return detail(state, playground.id)
  })
}
export async function savePlayground(
  id: string,
  value: unknown,
  revision: number
) {
  const parsed = playgroundSchema.parse(value)
  validateGraph(parsed.nodes)
  return mutate((state) => {
    const previous = detail(state, id).playground
    if (previous.revision !== revision)
      throw new Error("Playground changed. Reload before saving.")
    for (const node of parsed.nodes) {
      if (!state.apps.some((a) => a.id === node.appId))
        throw new Error("App not registered")
      const old = previous.nodes.find((n) => n.id === node.id)
      if (node.selectedAttemptId !== old?.selectedAttemptId)
        throw new Error("Use the select output action to change an attempt")
      if (node.appId !== old?.appId && node.selectedAttemptId)
        throw new Error("Add a new node to change its app")
    }
    Object.assign(previous, parsed, { revision: previous.revision + 1 })
    return detail(state, id)
  })
}
export async function runNode(id: string, nodeId: string, revision: number) {
  const prepared = await mutate((state) => {
    const { playground, attempts } = detail(state, id)
    if (playground.revision !== revision)
      throw new Error("Save or reload your playground before running")
    if (
      attempts.some(
        (a) =>
          a.nodeId === nodeId &&
          a.status === "running" &&
          Date.now() - Date.parse(a.createdAt) < 70_000
      )
    )
      throw new Error("This node is already running")
    const node = playground.nodes.find((n) => n.id === nodeId)
    const app = state.apps.find((a) => a.id === node?.appId)
    if (!app) throw new Error("App not found")
    const bridge = liveBridge(state, app.id)
    if (!bridge && state.connections?.[app.id]?.type !== "webhook")
      throw new Error("App is offline. Reconnect its bridge to run it.")
    const resolved = resolveNode(playground, nodeId, attempts, state.apps)
    validateSchema(app.inputSchema, resolved.input)
    const attempt: Attempt = {
      id: randomUUID(),
      playgroundId: id,
      nodeId,
      appId: app.id,
      appRevision: app.revision,
      appDefinition: app,
      createdAt: new Date().toISOString(),
      ...resolved,
      status: "running",
      evaluatorIds: node?.evaluatorIds ?? app.evaluatorIds,
      evalRunIds: [],
    }
    state.attempts.push(attempt)
    return { attempt, app, bridge }
  })
  try {
    const { app, attempt } = prepared
    const service = await getTracerService(workspaceIdentity()?.projectId ?? "")
    const resolvedApp = await resolveApp(app.id)
    const trace = await beginInvocation(service, resolvedApp, attempt.input, attempt.id)
    await mutate(state => { state.attempts.find(a => a.id === attempt.id)!.traceId = trace.id })
    const completed = await executeInvocation(service, resolvedApp, trace)
    if (completed.status === "errored") throw new Error(String(completed.attributes["error.message"]))
    await mutate(state => Object.assign(state.attempts.find(a => a.id === attempt.id)!, {
      output: completed.output, status: "completed", completedAt: new Date().toISOString(),
    }))
  } catch (error) {
    await mutate((state) =>
      Object.assign(state.attempts.find((a) => a.id === prepared.attempt.id)!, {
        status: "error",
        error: (error as Error).message,
        completedAt: new Date().toISOString(),
      })
    )
  }
  if (prepared.attempt.evaluatorIds?.length) {
    try {
      await evaluateAttempt(id, prepared.attempt.id, prepared.attempt.evaluatorIds, true)
    } catch (error) {
      await mutate(state => {
        state.attempts.find(a => a.id === prepared.attempt.id)!.scoringError = (error as Error).message
      })
    }
  }
  return getDetail(id)
}
export async function selectAttempt(
  id: string,
  attemptId: string,
  revision: number
) {
  return mutate((state) => {
    const { playground, attempts } = detail(state, id)
    if (playground.revision !== revision)
      throw new Error("Playground changed. Reload before selecting an output.")
    const attempt = attempts.find((a) => a.id === attemptId)
    if (!attempt || attempt.status !== "completed")
      throw new Error("Select a completed attempt")
    const node = playground.nodes.find((n) => n.id === attempt.nodeId)
    if (!node || node.appId !== attempt.appId)
      throw new Error("Node no longer exists")
    if (
      resolveNode(playground, node.id, attempts, state.apps).signature !==
      attempt.signature
    )
      throw new Error("This attempt has outdated inputs. Run the node again.")
    node.selectedAttemptId = attemptId
    playground.revision++
    return detail(state, id)
  })
}
export async function evaluateAttempt(
  id: string,
  attemptId: string,
  evaluatorIds: string[],
  waitForTraces = false
) {
  const state = await readState()
  const attempt = detail(state, id).attempts.find((a) => a.id === attemptId)
  if (!attempt || attempt.status === "running")
    throw new Error("Wait for the attempt to finish")
  const ids = z.array(z.string().min(1)).min(1).max(10).parse(evaluatorIds)
  const service = await getTracerService(workspaceIdentity()?.projectId ?? "")
  let traces = await runTracerEffect(
    service.listTraces({
      filter: `metadata."datool.call.id" = ${JSON.stringify(attempt.id)}`,
      limit: 100,
    })
  )
  if (attempt.traceId) {
    traces = { items: [await runTracerEffect(service.getTrace(attempt.traceId))], nextCursor: null, total: 1 }
    waitForTraces = false
  }
  const deadline = Date.now() + 20_000
  while (waitForTraces && (!traces.items.length || traces.items.some(t => !t.endedAt)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500))
    traces = await runTracerEffect(service.listTraces({
      filter: `metadata."datool.call.id" = ${JSON.stringify(attempt.id)}`,
      limit: 100,
    }))
  }
  if (!traces.items.length || traces.items.some((t) => !t.endedAt))
    throw new Error(
      "Waiting for completed traces. Try Evaluate again after traces arrive."
    )
  if (traces.nextCursor)
    throw new Error(
      "This attempt has more than 100 traces; evaluate them from the traces page"
    )
  const run = await runTracerEffect(
    service.createEvalRun({
      traceIds: traces.items.map((t) => t.id),
      evaluatorIds: ids,
      name: `Playground · ${attempt.appId}`,
      metadata: {
        "datool.call.id": attempt.id,
        playgroundId: id,
        nodeId: attempt.nodeId,
      },
    })
  )
  await mutate((state) => {
    const current = state.attempts.find((a) => a.id === attemptId)!
    current.evalRunIds.push(run.id)
    delete current.scoringError
  })
  return getDetail(id)
}

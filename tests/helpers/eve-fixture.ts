import { spawn, type ChildProcess } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { createServer } from "node:net"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import { closeTracerDatabase, createTracerDatabase } from "@/src/server/tracer/db"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "./postgres"

export type EveProvider = (body: Record<string, unknown>, request: IncomingMessage) => Response | Promise<Response>
const nativeFetch = globalThis.fetch
const serverLog = join(tmpdir(), "datool-eve-e2e-server.log")
let workflowReady: Promise<void> | undefined
export function eveResponse(body: Record<string, unknown>, text: string, call?: { name: string; input: unknown }) {
  const id = `resp_${randomUUID()}`
  const itemId = `item_${randomUUID()}`
  const response = { id, model: body.model, created_at: 1792784000, object: "response", status: "completed", usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } }
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { ...response, status: "in_progress" } }]
  if (call) {
    const callId = `call_${randomUUID()}`
    const item = { type: "function_call", id: itemId, call_id: callId, name: call.name, arguments: "" }
    events.push({ type: "response.output_item.added", output_index: 0, item })
    events.push({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: JSON.stringify(call.input) })
    events.push({ type: "response.function_call_arguments.done", item_id: itemId, output_index: 0, arguments: JSON.stringify(call.input) })
    events.push({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: JSON.stringify(call.input), status: "completed" } })
  } else {
    events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [], status: "in_progress" } })
    events.push({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text })
    events.push({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text })
    events.push({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed" } })
  }
  events.push({ type: "response.completed", response })
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
}


// The sole engine fixture uses real production transport, PostgreSQL checkpoints,
// and a separate Eve process. Only the paid vendor's HTTP endpoint is controlled.
export async function createEveFixture(options: { target?: Awaited<ReturnType<typeof createIsolatedPostgres>>; upstream?: typeof fetch } = {}) {
  workflowReady ??= new Promise<void>((resolve, reject) => {
    const setup = spawn("node", ["scripts/bootstrap-eve.mjs"], { env: { ...process.env, WORKFLOW_POSTGRES_URL: process.env.DATOOL_TEST_DATABASE_URL }, stdio: ["ignore", "ignore", "pipe"] })
    setup.stderr?.on("data", chunk => { void appendFile(join(tmpdir(), "datool-eve-bootstrap-test.log"), chunk) })
    setup.once("error", reject)
    setup.once("exit", code => code === 0 ? resolve() : reject(new Error("The test workflow database could not be initialized.")))
  })
  await workflowReady
  const target = options.target ?? await createIsolatedPostgres()
  if (!options.target) { await migrateIsolatedPostgres(target); await seedTestWorkspace(target) }
  const context = { database: createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema }), projectId: target.projectId }
  const secret = randomUUID() + randomUUID()
  const encryptionKey = options.target && (process.env.DATOOL_PROVIDER_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET) ? (process.env.DATOOL_PROVIDER_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET)! : randomUUID() + randomUUID()
  const previous = Object.fromEntries(["DATOOL_EVE_URL", "DATOOL_EVE_SECRET", "DATOOL_PROVIDER_ENCRYPTION_KEY"].map(key => [key, process.env[key]]))
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = encryptionKey
  await context.database.execute(sql`INSERT INTO project_model_provider(project_id,provider,encrypted_api_key) VALUES(${context.projectId},'openai',${encryptProviderKey("eve-project-key", context.projectId, "openai")})`)
  const requests: Array<Record<string, unknown>> = []
  let handler: EveProvider = body => eveResponse(body, "Done.")
  const provider = createHttpServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      if (request.url === "/upstream" && options.upstream) {
        const upstream = await options.upstream(String(body.url), { method: String(body.method), headers: body.headers as Record<string,string>, ...(body.body ? { body: String(body.body) } : {}) })
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      requests.push(body)
      const result = await handler(body, request)
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    })().catch(error => { void appendFile(join(tmpdir(), "datool-eve-fixture-errors.log"), String(error?.stack ?? error) + "\n"); response.writeHead(500); response.end("Test provider failed.") })
  })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  process.env.DATOOL_EVE_URL = `http://127.0.0.1:${port}`
  process.env.DATOOL_EVE_SECRET = secret
  let eve: ChildProcess | undefined
  async function start() {
    eve = spawn("node", [options.upstream ? "tests/helpers/start-eve-fixture.mjs" : "scripts/start-eve.mjs"], { cwd: process.cwd(), env: {
      ...process.env, NODE_ENV: "production", DATABASE_URL: target.databaseUrl,
      WORKFLOW_POSTGRES_URL: process.env.DATOOL_TEST_DATABASE_URL!,
      // Each fixture has a different application schema. Workers sharing the
      // disposable workflow DB must never consume another fixture's tasks.
      WORKFLOW_POSTGRES_JOB_PREFIX: `datool_${target.schema}_`,
      WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS: "1", DATOOL_EVE_PORT: String(port),
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "4", WORKFLOW_POSTGRES_MAX_POOL_SIZE: "8",
      DATOOL_EVE_SECRET: secret, DATOOL_PROVIDER_ENCRYPTION_KEY: encryptionKey,
      OPENAI_BASE_URL: `${providerUrl}/v1`, DATOOL_BILLING_ENABLED: "false",
      DATOOL_EVE_TEST_UPSTREAM_URL: providerUrl,
    }, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    for (const stream of [eve.stdout, eve.stderr]) stream?.on("data", chunk => { void appendFile(serverLog, chunk) })
    if (options.upstream) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test network interception did not become ready.")), 30_000)
      eve!.once("message", () => { clearTimeout(timer); resolve() })
      eve!.once("exit", () => { clearTimeout(timer); reject(new Error("Eve exited while installing the test network.")) })
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (eve.exitCode !== null) throw new Error(`Eve exited before becoming ready (${eve.exitCode}). See ${serverLog}`)
      try {
        const result = await nativeFetch(`http://127.0.0.1:${port}/eve/v1/health`, { headers: { authorization: `Basic ${Buffer.from(`datool:${secret}`).toString("base64")}` } })
        if (result.ok) return
      } catch { /* Starting the actual service. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error("Eve did not become ready.")
  }
  async function stop() {
    if (!eve || eve.exitCode !== null) return
    const child = eve
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    process.kill(-child.pid!, "SIGKILL")
    await exited
  }
  await start()
  return { target, context, requests, secret, port, start, stop,
    provider: (next: EveProvider) => { handler = next },
    async close() {
      await stop()
      provider.closeAllConnections()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      await closeTracerDatabase(context.database)
      if (!options.target) await target.close()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

export function toolOutputs(body: Record<string, unknown>) {
  return (body.input as Array<{ type: string; output?: unknown }>).filter(item => item.type === "function_call_output").map(item => {
    try { return typeof item.output === "string" ? JSON.parse(item.output) : item.output } catch { return item.output }
  })
}

export function discoveredTools(body: Record<string, unknown>) {
  return toolOutputs(body).flatMap(item => item?.results ?? []) as Array<{ tool: string }>
}

/** Script the real search/invoke protocol, without bypassing the Eve engine. */
export function invokeTool(body: Record<string, unknown>, input: Record<string, unknown> = {}, text = "Done.", query = "Lookup") {
  const outputs = toolOutputs(body)
  if (!outputs.length) return eveResponse(body, "", { name: "eve__search", input: { query } })
  const tool = discoveredTools(body).find(item => item.tool.startsWith("action_") || item.tool === "bash")
  if (tool && outputs.length === 1) return eveResponse(body, "", { name: "eve__tool", input: { name: tool.tool, input } })
  return eveResponse(body, text)
}

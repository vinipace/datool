import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { dataDirectory } from "@/src/server/auth/context"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { invokeTransport, type TransportTarget } from "./transports"

export const connectionSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["agent", "input"]),
  url: z
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "Use an HTTP or HTTPS URL"
    ),
  token: z.string().max(4096).optional(),
})
export type Connection = z.infer<typeof connectionSchema> & { id: string; target?: TransportTarget }
let queue = Promise.resolve()
export async function readConnections(): Promise<Connection[]> {
  const file = join(dataDirectory(), "apps.json")
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
export function saveConnection(input: unknown) {
  const parsed = connectionSchema.parse(input)
  const operation = queue.then(async () => {
    const apps = await readConnections()
    const existing = apps.find((app) => app.url === parsed.url)
    const app = { ...parsed, id: parsed.id ?? existing?.id ?? randomUUID() }
    const next = [...apps.filter((item) => item.id !== app.id), app]
    const directory = dataDirectory()
    const file = join(directory, "apps.json")
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
    await rename(temporary, file)
    return app
  })
  queue = operation.then(
    () => {},
    () => {}
  )
  return operation
}
export function publicConnection(app: Connection) {
  return { id: app.id, name: app.name, mode: app.mode, url: app.url }
}
export const callSchema = z.union([
  z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        })
      )
      .min(1),
  }),
  z
    .object({ input: z.unknown() })
    .refine((value) => Object.hasOwn(value, "input"), "input is required"),
])
export async function invokeConnection(
  app: Connection,
  payload: unknown,
  callId: string = randomUUID(),
  options?: { promptScope?: PromptRunScope; traceId: string; onResponse?: (response: Response) => void }
) {
  const body = callSchema.parse(payload)
  if (app.mode === "agent" ? !("messages" in body) : !("input" in body))
    throw new Error(
      `App requires ${app.mode === "agent" ? "messages" : "input"}`
    )
  if (app.target) {
    const result = await invokeTransport(app.target, app.mode === "agent" ? payload : (body as { input: unknown }).input, payload, {
      appId: app.id, callId, traceId: options?.traceId, promptScope: options?.promptScope,
    })
    options?.onResponse?.(new Response(null, { headers: result.telemetryComplete ? { "x-datool-telemetry-complete": "true" } : {} }))
    return result.output
  }
  const response = await fetch(app.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-datool-connection-id": app.id,
      "x-datool-call-id": callId,
      ...(options?.promptScope ? { "x-datool-prompt-scope": Buffer.from(JSON.stringify(options.promptScope)).toString("base64url") } : {}),
      ...(options ? { "x-datool-invocation-trace-id": options.traceId, traceparent: `00-${options.traceId}-${randomUUID().replaceAll("-", "").slice(0,16)}-01` } : {}),
      ...(app.token ? { Authorization: `Bearer ${app.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  })
  options?.onResponse?.(response)
  if (!response.ok) throw new Error(`App returned HTTP ${response.status}`)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

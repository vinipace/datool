import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { CodexReader } from "./app-server"
import { decodeOtlp, fingerprint, mergeTelemetry } from "./otlp"
import { normalizeCodexTurn } from "./normalize"
import { fetchWithRetry } from "../tracer/retry"
import type { CodexSnapshot, Telemetry } from "./types"

type Delivery = { snapshot: CodexSnapshot; digest: string }
type Options = {
  stateDir: string
  baseUrl: string
  projectId: string
  apiKey: string
  executable?: string
  cwd?: string
  onSaved?: (result: Saved) => void
}
export type Saved = {
  traceId: string
  sessionId: string
  status: string
  spanCount: number
  threadId: string
  turnId: string
}

export async function writePrivateJson(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export class CodexCollector {
  private reader: CodexReader
  private token = ""
  private generations = new Set<string>()
  private delivered: Record<string, string> = {}
  private syncPromise: Promise<Saved[]> | undefined
  private closed = false
  readonly stateDir: string

  constructor(private readonly options: Options) {
    this.stateDir = resolve(options.stateDir)
    this.reader = new CodexReader(options.executable)
    const url = new URL(options.baseUrl)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("Invalid Datool destination URL")
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Remote Datool destinations require HTTPS")
    if (!options.apiKey || !options.projectId)
      throw new Error("DATOOL_API_KEY and DATOOL_PROJECT_ID are required")
  }

  async initialize() {
    for (const dir of [
      this.stateDir,
      `${this.stateDir}/journal`,
      `${this.stateDir}/outbox`,
    ])
      await mkdir(dir, { recursive: true, mode: 0o700 })
    const manifestPath = `${this.stateDir}/destination.json`
    const destination = {
      baseUrl: this.options.baseUrl.replace(/\/$/, ""),
      projectId: this.options.projectId,
    }
    try {
      const existing = JSON.parse(await readFile(manifestPath, "utf8"))
      if (
        existing.baseUrl !== destination.baseUrl ||
        existing.projectId !== destination.projectId
      )
        throw new Error(
          "Capture directory belongs to a different Datool destination; use a separate --state-dir"
        )
      this.token = existing.collectorToken
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      this.token = randomBytes(32).toString("hex")
      await writePrivateJson(manifestPath, {
        ...destination,
        collectorToken: this.token,
      })
    }
    try {
      this.delivered = JSON.parse(
        await readFile(`${this.stateDir}/delivered.json`, "utf8")
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (!this.token) throw new Error("Invalid collector manifest")
  }

  configuration(endpoint: string) {
    return `[otel]\nlog_user_prompt = true\n\n[otel.exporter.otlp-http]\nendpoint = ${JSON.stringify(`${endpoint}/v1/logs`)}\nprotocol = "json"\nheaders = { "authorization" = "Bearer ${this.token}" }\n\n[otel.trace_exporter.otlp-http]\nendpoint = ${JSON.stringify(`${endpoint}/v1/traces`)}\nprotocol = "json"\nheaders = { "authorization" = "Bearer ${this.token}" }\n`
  }

  codexArguments(endpoint: string) {
    const exporter = (path: string) =>
      `{otlp-http={endpoint=${JSON.stringify(`${endpoint}/v1/${path}`)},protocol="json",headers={authorization="Bearer ${this.token}"}}}`
    return [
      "-c",
      `otel.exporter=${exporter("logs")}`,
      "-c",
      `otel.trace_exporter=${exporter("traces")}`,
      "-c",
      "otel.log_user_prompt=true",
    ]
  }

  async receive(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/health")
      return Response.json({ status: "ok" })
    if (request.method !== "POST" || !["/v1/logs", "/v1/traces"].includes(path))
      return new Response(null, { status: 404 })
    const authorization = Buffer.from(
        request.headers.get("authorization") ?? ""
      ),
      expected = Buffer.from(`Bearer ${this.token}`)
    if (
      request.headers.has("origin") ||
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    )
      return new Response(null, { status: 401 })
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      return Response.json(
        { message: "Use OTLP/HTTP protocol=json" },
        { status: 415 }
      )
    if (this.closed) return new Response(null, { status: 503 })
    try {
      const reader = request.body?.getReader()
      if (!reader) return new Response(null, { status: 400 })
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > 32 * 1024 * 1024) {
          await reader.cancel()
          return new Response(null, { status: 413 })
        }
        chunks.push(next.value)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const signal = path === "/v1/logs" ? "logs" : "traces"
      decodeOtlp(signal, body)
      const id = fingerprint({ signal, body })
      await writePrivateJson(`${this.stateDir}/journal/${id}.json`, {
        signal,
        body,
      })
      // Acknowledgment follows disk sync. Failed uploads remain replayable after restart.
      return Response.json({})
    } catch (error) {
      const badInput =
        error instanceof SyntaxError ||
        (error as Error).name === "ZodError" ||
        (error as Error).message.startsWith("Invalid OTLP") ||
        (error as Error).message.startsWith("OTLP batch")
      return Response.json(
        {
          message: badInput
            ? "Invalid OTLP JSON batch"
            : "Could not persist telemetry capture",
        },
        { status: badInput ? 400 : 503 }
      )
    }
  }

  sync(threadId?: string): Promise<Saved[]> {
    if (this.syncPromise) return this.syncPromise
    this.syncPromise = this.synchronize(threadId).finally(() => {
      this.syncPromise = undefined
    })
    return this.syncPromise
  }

  private async synchronize(explicitThreadId?: string): Promise<Saved[]> {
    const saved = await this.drainOutbox()
    const files = (await readdir(`${this.stateDir}/journal`))
      .filter((f) => f.endsWith(".json"))
      .sort()
    const generation = fingerprint(files)
    if (!explicitThreadId && this.generations.has(generation)) return saved
    const batches: Telemetry[] = []
    for (const file of files) {
      const record = JSON.parse(
        await readFile(`${this.stateDir}/journal/${file}`, "utf8")
      )
      batches.push(decodeOtlp(record.signal, record.body))
    }
    const telemetry = mergeTelemetry(batches)
    const roots = telemetry.spans.filter(
      (s) =>
        s.name === "session_task.turn" &&
        typeof s.attributes["thread.id"] === "string" &&
        typeof s.attributes["turn.id"] === "string"
    )
    const threadIds = explicitThreadId
      ? [explicitThreadId]
      : [...new Set(roots.map((s) => String(s.attributes["thread.id"])))]
    let complete = true
    for (const threadId of threadIds) {
      const thread = await this.reader.readThread(threadId)
      if (this.options.cwd && resolve(thread.cwd) !== resolve(this.options.cwd))
        continue
      const capturedTurns = new Set(
        roots
          .filter((s) => s.attributes["thread.id"] === threadId)
          .map((s) => s.attributes["turn.id"])
      )
      for (const turn of thread.turns) {
        if (!explicitThreadId && !capturedTurns.has(turn.id)) continue
        if (turn.status === "inProgress") {
          complete = false
          continue
        }
        const snapshot = normalizeCodexTurn(
          thread,
          turn,
          telemetry,
          new Date().toISOString()
        )
        const digest = contentDigest(snapshot)
        const identity = `${threadId}:${turn.id}`
        if (this.delivered[identity] === digest) continue
        await writePrivateJson(
          `${this.stateDir}/outbox/${snapshot.capturedAt.replaceAll(":", "-")}-${fingerprint(identity)}.json`,
          { snapshot, digest } satisfies Delivery
        )
        saved.push(...(await this.drainOutbox()))
      }
      if (
        [...capturedTurns].some((id) => !thread.turns.some((t) => t.id === id))
      )
        complete = false
    }
    if (complete) this.generations.add(generation)
    return saved
  }

  private async drainOutbox(): Promise<Saved[]> {
    const results: Saved[] = []
    for (const file of (await readdir(`${this.stateDir}/outbox`))
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const { snapshot, digest } = JSON.parse(
        await readFile(`${this.stateDir}/outbox/${file}`, "utf8")
      ) as Delivery
      const response = await fetchWithRetry(
        fetch,
        `${this.options.baseUrl.replace(/\/$/, "")}/api/ingest/codex`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
            "x-project-id": this.options.projectId,
          },
          body: JSON.stringify(snapshot),
          redirect: "error",
        },
        { retries: 3, timeoutMs: 30_000 }
      )
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        const detail =
          typeof error?.error?.message === "string"
            ? `: ${error.error.message.slice(0, 300)}`
            : ""
        throw new Error(
          `Datool Codex persistence failed (HTTP ${response.status})${detail}; pending capture retained in ${this.stateDir}`
        )
      }
      const result = (await response.json()).data
      if (!result?.traceId || !["saved", "unchanged"].includes(result.status))
        throw new Error("Invalid Datool persistence receipt")
      this.delivered[`${snapshot.threadId}:${snapshot.turnId}`] = digest
      await writePrivateJson(`${this.stateDir}/delivered.json`, this.delivered)
      await unlink(`${this.stateDir}/outbox/${file}`)
      const saved = {
        ...result,
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
      } as Saved
      results.push(saved)
      this.options.onSaved?.(saved)
    }
    return results
  }

  close() {
    this.closed = true
    this.reader.close()
  }
}

function contentDigest(snapshot: CodexSnapshot) {
  // Quote generation time is not a change in captured evidence.
  return fingerprint(
    JSON.parse(
      JSON.stringify({ ...snapshot, capturedAt: undefined }, (key, value) =>
        key === "cost.calculated_at" ? undefined : value
      )
    )
  )
}

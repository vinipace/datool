import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve, sep } from "node:path"
import type { CodexThread, CodexTurn } from "./types"
import type { JsonObject } from "../tracer/contracts"
import { codexEnvironment } from "./environment"

/** Separate read-only connection: never resume a thread or subscribe to its execution. */
export class CodexReader {
  private child: ReturnType<typeof spawn> | undefined
  private sequence = 0
  private ready: Promise<void> | undefined
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(private readonly executable = "codex") {}

  private start() {
    return (this.ready ??= (async () => {
      this.child = spawn(
        this.executable,
        [
          "app-server",
          "-c",
          'otel.exporter="none"',
          "-c",
          'otel.trace_exporter="none"',
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: codexEnvironment() }
      )
      const fail = () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error("Codex App Server connection closed"))
        }
        this.pending.clear()
        this.ready = undefined
      }
      this.child.on("error", fail)
      this.child.on("exit", fail)
      // Drain diagnostic output; it can contain user content, so do not echo it.
      this.child.stderr!.resume()
      createInterface({ input: this.child.stdout! }).on("line", (line) => {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        const p = this.pending.get(message.id)
        if (!p) return
        this.pending.delete(message.id)
        clearTimeout(p.timer)
        if (message.error)
          p.reject(
            new Error(`Codex App Server request failed (${message.error.code})`)
          )
        else p.resolve(message.result)
      })
      await this.request("initialize", {
        clientInfo: { name: "datool_trace_reader", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      })
      this.child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n")
    })())
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, 30_000)
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n")
    })
  }

  async readThread(threadId: string): Promise<CodexThread> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId))
      throw new Error("Invalid Codex thread ID")
    await this.start()
    const { thread } = await this.request<{
      thread: CodexThread & { path?: string | null }
    }>("thread/read", { threadId, includeTurns: false })
    if (thread.id !== threadId)
      throw new Error("Codex returned a different thread")
    const turns: CodexTurn[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.request<{
        data: CodexTurn[]
        nextCursor: string | null
      }>("thread/turns/list", {
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      turns.push(...page.data)
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor))
        throw new Error("Codex returned a repeated history cursor")
      if (cursor) cursors.add(cursor)
      if (turns.length > 10_000)
        throw new Error("Codex history exceeds 10,000 turns; split the import")
    } while (cursor)
    const history = await readRecordedItems(threadId, thread.path)
    return { ...thread, turns, ...history }
  }

  close() {
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = undefined
    this.ready = undefined
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error("Codex reader closed"))
    }
    this.pending.clear()
  }
}

/** Optional fidelity layer for legacy JSONL histories, not a dependency on undocumented storage. */
async function readRecordedItems(
  threadId: string,
  path: string | null | undefined
) {
  const fallback = { recordedItems: [], historyCoverage: "app_server_items" }
  if (!path) return fallback
  try {
    const root = await realpath(
      process.env.CODEX_HOME ?? resolve(homedir(), ".codex")
    )
    const file = await realpath(path)
    if (
      !file.startsWith(root + sep) ||
      !file.endsWith(".jsonl") ||
      !file.includes(threadId)
    )
      return fallback
    if ((await stat(file)).size > 256 * 1024 * 1024) return fallback
    const recordedItems: NonNullable<CodexThread["recordedItems"]> = []
    let verified = false
    let compacted = false
    for await (const line of createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    })) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      } // an active writer may leave an incomplete final line
      if (row.type === "session_meta") verified = row.payload?.id === threadId
      if (!verified) continue
      if (row.type === "compacted") compacted = true
      const at = Date.parse(row.timestamp)
      if (row.type !== "response_item" || !Number.isFinite(at)) continue
      const item = { ...row.payload } as JsonObject
      // Encrypted reasoning is not inspectable evidence. Keep only exported summaries.
      delete item.encrypted_content
      if (item.type === "reasoning") delete item.content
      recordedItems.push({ at, item })
    }
    return verified
      ? {
          recordedItems,
          historyCoverage: compacted
            ? "recorded_items_with_compaction"
            : "recorded_items",
        }
      : fallback
  } catch {
    return fallback
  }
}

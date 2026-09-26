#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { open } from "node:fs/promises"
import { CodexCollector } from "../src/lib/codex-traces/collector"
import { serveCodexCollector } from "../src/lib/codex-traces/server"
import { codexEnvironment } from "../src/lib/codex-traces/environment"

const args = process.argv.slice(2)
const command = args.shift()
if (!command || command === "--help") {
  console.log(`Capture Codex traces locally, including conversation and per-request usage.

  bun scripts/codex-traces.ts serve [--port 4318] [--state-dir .data/codex] [--cwd PATH]
  bun scripts/codex-traces.ts run [--state-dir PATH] -- [codex exec options] PROMPT
  bun scripts/codex-traces.ts import --thread THREAD_ID [--state-dir .data/codex]

Required: DATOOL_PROJECT_ID and DATOOL_API_KEY (traces:write).
DATOOL_BASE_URL defaults to http://localhost:3000. CODEX_BIN defaults to codex.
The serve command writes a private otel.config.toml snippet to its state directory.
Run mode sets telemetry only for the child Codex process and waits for PostgreSQL persistence.
Raw batches and pending uploads survive restarts. No global Codex configuration is edited.`)
  process.exit(0)
}
if (!["serve", "run", "import"].includes(command))
  throw new Error("Expected serve, run, or import")
let port = command === "run" ? 0 : 4318
let stateDir = ".data/codex",
  cwd: string | undefined,
  threadId: string | undefined
while (args.length && args[0] !== "--") {
  const flag = args.shift()
  if (!["--port", "--state-dir", "--cwd", "--thread"].includes(flag ?? ""))
    throw new Error(
      `Unknown connector option: ${flag}; put Codex options after --`
    )
  const value = args.shift()
  if (!value) throw new Error(`Missing value for ${flag}`)
  if (flag === "--port") {
    port = Number(value)
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port")
  }
  if (flag === "--state-dir") stateDir = value
  if (flag === "--cwd") cwd = resolve(value)
  if (flag === "--thread") threadId = value
}
if (args[0] === "--") args.shift()
const collector = new CodexCollector({
  stateDir,
  cwd,
  baseUrl: process.env.DATOOL_BASE_URL ?? "http://localhost:3000",
  projectId: process.env.DATOOL_PROJECT_ID ?? "",
  apiKey: process.env.DATOOL_API_KEY ?? "",
  executable: process.env.CODEX_BIN,
  onSaved: (saved) =>
    console.error(JSON.stringify({ event: "datool.trace.saved", ...saved })),
})
await collector.initialize()

if (command === "import") {
  if (!threadId) throw new Error("import requires --thread")
  try {
    const saved = await collector.sync(threadId)
    console.log(JSON.stringify({ saved }))
  } finally {
    collector.close()
  }
} else {
  const server = await serveCodexCollector(
    (request) => collector.receive(request),
    port
  )
  const endpoint = `http://127.0.0.1:${server.port}`
  console.error(
    `Codex telemetry receiver: ${endpoint}; durable capture: ${collector.stateDir}`
  )
  if (command === "serve") {
    const file = await open(
      `${collector.stateDir}/otel.config.toml`,
      "w",
      0o600
    )
    try {
      await file.writeFile(collector.configuration(endpoint))
      await file.sync()
    } finally {
      await file.close()
    }
    console.error(
      `Codex configuration snippet: ${collector.stateDir}/otel.config.toml`
    )
    const timer = setInterval(() => {
      void collector.sync().catch((error) => console.error(error.message))
    }, 3000)
    const stop = async () => {
      clearInterval(timer)
      await server.stop(false)
      try {
        await collector.sync()
      } finally {
        collector.close()
      }
    }
    process.once("SIGINT", () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    })
    process.once("SIGTERM", () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    })
    await collector.sync().catch((error) => console.error(error.message))
  } else {
    let code = 1
    try {
      const child = spawn(
        process.env.CODEX_BIN ?? "codex",
        ["exec", ...args, ...collector.codexArguments(endpoint)],
        { stdio: "inherit", env: codexEnvironment(), ...(cwd ? { cwd } : {}) }
      )
      code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => resolve(code ?? 1))
      })
      // Codex flushes exporters on exit; all receiver handlers must finish before reading the journal.
      await server.stop(false)
      const saved = await collector.sync()
      if (!saved.length)
        throw new Error(
          "Codex exited without a newly persisted trace; inspect the retained journal"
        )
    } finally {
      await server.stop(true)
      collector.close()
    }
    process.exitCode = code
  }
}

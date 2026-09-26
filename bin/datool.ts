#!/usr/bin/env node
import { resolve, basename } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"

import { resourcesCommand } from "./resources"
import { appRequest } from "./request"
import { agentCommand, agentUsage } from "./agent"
import { loadConfiguration, serverOrigin } from "./config"
import { readProfile } from "./credentials"
import { authCommand } from "./oauth"
import { doctor } from "./doctor"
import { connectOptions } from "./connect-options"
import { prepareConnectionWorker, watchConnection } from "./connect-watch"

const usage = `Datool CLI

  datool connect [config.ts|handler.ts|http-url] [--mode workflow|agent] [--name name] [--watch|--no-watch]
  datool apps sync <config.ts>
  datool datasets|scorers push <file.json> [--dry-run]
  datool datasets|scorers pull <key> --out <file.json> [--replace]
  datool auth login [--no-browser] | logout
  datool doctor [--json] [--scorer-ids id,id] [--probe --trace-id id --span-id id]

Options: --datool <url> --project <id> --env-file <path> --no-env
Environment: DATOOL_BASE_URL (or DATOOL_URL), DATOOL_PROJECT_ID, DATOOL_API_KEY
connect defaults to the project-root datool.config.ts manifest, syncs it, and starts a listener.
--watch reloads local project source/config in fresh processes after active calls and result delivery finish.
Watching is opt-in; node_modules, build outputs and Git files are excluded. HTTP webhooks cannot use --watch.
Loads project-root .env then .env.local; shell values win. DATOOL_NO_ENV=1 opts out.
Explicit --env-file replaces automatic files and may be repeated (last file wins).
For direct Bun execution, use bun --no-env-file <datool.js> to disable Bun preloading.
Local TypeScript handlers require Node 22.18+ and erasable TypeScript syntax.`

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.info(`${usage}\n\n${agentUsage}`)
  process.exit(0)
}
if (process.argv.includes("--version")) {
  console.info(process.env.DATOOL_CLI_VERSION ?? "development")
  process.exit(0)
}
// Bun changes process.env before JS runs. Require its runtime opt-out rather than
// guessing which preloaded values were exported by the user's shell.
if (process.versions.bun && !process.execArgv.includes("--no-env-file")) {
  console.error(
    "For predictable project configuration, run: bun --no-env-file <datool.js> <command>. The installed datool/bunx command uses Node automatically."
  )
  process.exit(1)
}
const configuration = loadConfiguration(process.argv.slice(2))
process.argv = [...process.argv.slice(0, 2), ...configuration.args]
const profile = process.env.DATOOL_API_KEY?.trim() ? null : await readProfile()
if (profile) {
  if (!process.env.DATOOL_BASE_URL && !process.env.DATOOL_URL) {
    process.env.DATOOL_BASE_URL = profile.origin
    configuration.sources.DATOOL_BASE_URL = "saved login"
  }
  const host = serverOrigin(
    process.env.DATOOL_BASE_URL ?? process.env.DATOOL_URL!
  )
  if (host === profile.origin && !process.env.DATOOL_PROJECT_ID) {
    process.env.DATOOL_PROJECT_ID = profile.projectId
    configuration.sources.DATOOL_PROJECT_ID = "saved login"
  }
}
const authExit = await authCommand(configuration.args)
if (authExit !== null) process.exit(authExit)
if (configuration.args[0] === "doctor")
  process.exit(await doctor(configuration))

if (
  ["datasets", "scorers"].includes(process.argv[2]) &&
  ["push", "pull"].includes(process.argv[3])
) {
  await resourcesCommand(process.argv.slice(2))
  process.exit(0)
}

const agentExit = await agentCommand(process.argv.slice(2))
if (agentExit !== null) {
  // Node pipes are asynchronous; a large native preview/read must not be cut
  // short by process.exit after console.info queued its JSON.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => stream.write("", () => resolve()))
    )
  )
  process.exit(agentExit)
}

import { syncApps, connectApps, parseAppManifest } from "./app-bridge.ts"

if (process.argv[2] === "apps" && process.argv[3] === "sync") {
  const target = process.argv[4]
  if (!target) throw new Error("Usage: datool apps sync <config.ts>")
  const index = process.argv.indexOf("--datool")
  const origin =
    (index >= 0 ? process.argv[index + 1] : undefined) ??
    process.env.DATOOL_BASE_URL ??
    process.env.DATOOL_URL ??
    "http://127.0.0.1:3000"
  process.env.DATOOL_BASE_URL = origin
  const config = (await import(pathToFileURL(resolve(target)).href)).default
  if (!Array.isArray(config?.apps))
    throw new Error("Config must export { apps: [...] }")
  await syncApps(config, origin)
  process.exit(0)
}
const [command, ...args] = process.argv.slice(2)
if (command !== "connect") {
  console.error(usage)
  process.exit(1)
}
const { target, mode, name, defaultManifest, watch } = connectOptions(
  args,
  configuration.root
)
if (defaultManifest && !existsSync(target) && !watch)
  throw new Error(
    `No manifest found at ${target}. Create datool.config.ts exporting defineApps({ apps: [...] }), or pass a handler file to datool connect.`
  )
const origin =
  process.env.DATOOL_BASE_URL ??
  process.env.DATOOL_URL ??
  "http://127.0.0.1:3000"
const identity = createHash("sha256")
  .update(`${origin}:${resolve(target)}`)
  .digest("hex")
  .slice(0, 32)
const connectionId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20)}`
const url = target
const token = process.env.DATOOL_APP_TOKEN
if (!/^https?:\/\//.test(target)) {
  if (watch) {
    await watchConnection(target, args, configuration.root, origin)
    process.exit(0)
  }
  process.env.DATOOL_CONNECTION_ID = connectionId
  process.env.DATOOL_BASE_URL = origin
  const module = await import(pathToFileURL(resolve(target)).href)
  const serve = async (config: Parameters<typeof connectApps>[0]) => {
    parseAppManifest(config)
    if (process.send && process.env.DATOOL_CONNECT_WORKER === "1") {
      const worker = await prepareConnectionWorker()
      if (!worker.activated) return
      await connectApps(config, origin, {
        signal: worker.signal,
        watched: true,
        resume: worker.resume,
        onConnected: (session) => process.send!({ session }),
      })
    } else await connectApps(config, origin)
  }
  if (Array.isArray(module.default?.apps)) {
    delete process.env.DATOOL_CONNECTION_ID
    await serve(module.default)
    process.exit(0)
  }
  if (defaultManifest)
    throw new Error(
      "datool.config.ts must export a manifest: defineApps({ apps: [...] })."
    )
  const handler = module.default
  if (typeof handler !== "function")
    throw new Error("Local app must export a default function")
  delete process.env.DATOOL_CONNECTION_ID
  await serve({
    apps: [
      {
        id: connectionId,
        name: name ?? basename(target),
        mode,
        inputSchema: { type: "object" },
        outputSchema: {},
        handler,
      },
    ],
  })
  process.exit(0)
}

await appRequest(origin, "/api/apps/config", [
  {
    id: connectionId,
    name: name ?? new URL(url).hostname,
    mode,
    inputSchema: { type: "object" },
    outputSchema: {},
    connection: {
      type: "webhook",
      url,
      body: "envelope",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  },
])
console.info(`HTTP app registered. Open ${origin}/playground`)

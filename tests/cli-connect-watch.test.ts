import { test, expect } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { serveWebhook } from "../src/server/apps/webhook"
import type { BridgeJob, BridgeResult } from "../src/lib/playground/connections"
import type { AppDefinition } from "../src/lib/playground/contracts"
import { connectOptions } from "../bin/connect-options"

test("watch is opt-in for local files; explicit no-watch and HTTP registration stay supported", () => {
  expect(connectOptions([], "/project").watch).toBe(false)
  expect(connectOptions(["--watch"], "/project").watch).toBeTruthy()
  expect(
    connectOptions(["handler.ts", "--watch", "--no-watch"], "/project").watch
  ).toBe(false)
  expect(() =>
    connectOptions(["https://example.test", "--watch"], "/project")
  ).toThrow("local")
})

test("CLI watches imports and schemas in fresh processes, recovers invalid edits, and drains calls including uncertain result delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-watch-"))
  const binary =
    process.env.DATOOL_TEST_CLI_BINARY ??
    fileURLToPath(new URL("../bin/datool.ts", import.meta.url))
  expect(existsSync(binary)).toBe(true)
  let definitions: AppDefinition[] = []
  const registrations: {
    id: string
    revisions: Record<string, number>
    disconnect?: boolean
  }[] = []
  const jobs: BridgeJob[] = []
  const claims = new Map<string, BridgeJob[]>()
  const results = new Map<string, BridgeResult>()
  const blockedRequests: string[] = []
  let blockedId = ""
  let allowAck = false
  let output = ""
  let child: ChildProcessWithoutNullStreams | undefined
  const server = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    const body = await request.json()
    if (path === "/api/apps/config") {
      definitions = (body as AppDefinition[]).map((app) => {
        const { revision = 0, ...previous } =
          definitions.find((saved) => saved.id === app.id) ?? {}
        return {
          ...app,
          revision:
            revision +
            (JSON.stringify(previous) === JSON.stringify(app) ? 0 : 1),
        }
      })
      return Response.json({ data: definitions })
    }
    if (path === "/api/apps/bridges") {
      registrations.push(body)
      return Response.json({
        data: { transport: "relay", protocolVersion: 2, reload: "session-v1" },
      })
    }
    if (path === "/api/apps/bridges/exchange") {
      const claimed =
        claims.get(body.requestId) ?? jobs.splice(0, body.capacity)
      claims.set(body.requestId, claimed)
      for (const item of body.results) results.set(item.id, item.result)
      if (
        !allowAck &&
        body.results.some((item: { id: string }) => item.id === blockedId)
      ) {
        blockedRequests.push(body.requestId)
        return Response.json({ error: {} }, { status: 503 })
      }
      return Response.json({
        data: {
          jobs: claimed,
          acknowledged: body.results.map((item: { id: string }) => item.id),
        },
      })
    }
    return Response.json({ error: {} }, { status: 404 })
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("DATOOL_") && key !== "NODE_OPTIONS"
    )
  )
  async function until(predicate: () => boolean, description: string) {
    const deadline = Date.now() + 20000
    while (!predicate() && Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode !== null))
        throw new Error(`CLI exited: ${output}`)
      await delay(25)
    }
    if (!predicate()) throw new Error(`Timed out: ${description}\n${output}`)
  }
  const connections = () => registrations.filter((row) => !row.disconnect)
  function start(args: string[] = []) {
    output = ""
    child = spawn(
      process.env.DATOOL_TEST_CLI_BINARY ? "node" : process.execPath,
      [
        ...(process.env.DATOOL_TEST_CLI_BINARY ? [] : ["--no-env-file"]),
        binary,
        "connect",
        ...args,
      ],
      {
        cwd: directory,
        env: {
          ...env,
          NODE_ENV: "test",
          DATOOL_BASE_URL: `http://127.0.0.1:${server.port}`,
          DATOOL_PROJECT_ID: "watch-fixture",
          DATOOL_API_KEY: "dtk_watch_fixture",
          DATOOL_CONFIG_DIR: join(directory, "credentials"),
        },
        stdio: "pipe",
      }
    )
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await Promise.race([
      exited,
      delay(10000).then(() => {
        throw new Error(`Shutdown timed out: ${output}`)
      }),
    ])
  }
  function enqueue(input: BridgeJob["input"] = {}, appId = "workflow") {
    const id = randomUUID()
    jobs.push({
      id,
      appId,
      input,
      callId: randomUUID(),
      deadline: Date.now() + 60000,
    })
    return id
  }
  async function call(input: BridgeJob["input"] = {}, appId?: string) {
    const id = enqueue(input, appId)
    await until(() => results.has(id), "call result")
    const result = results.get(id)!
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    return result.output as { version: string; counter: number; pid: number }
  }
  async function manifest(schema = false) {
    await writeFile(
      join(directory, "datool.config.ts"),
      `
      import { handler } from './src/handler.ts'
      export default { apps: [{ id: 'workflow', name: 'Workflow', type: 'workflow',
        inputSchema: ${JSON.stringify(schema ? { $id: "urn:datool:watch-input", type: "object", properties: { model: { type: "string" } }, required: ["model"] } : { type: "object", $id: "urn:datool:watch-input" })},
        outputSchema: {type:'object'}, handler }] }
    `
    )
  }
  async function dependency(version: string) {
    await writeFile(
      join(directory, "src/version.ts"),
      `export const version = ${JSON.stringify(version)}\n`
    )
  }
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await mkdir(join(directory, "src"))
    await writeFile(
      join(directory, "src/handler.ts"),
      `
      import { version } from './version.ts'
      import { appendFile, access } from 'node:fs/promises'
      import { setTimeout as delay } from 'node:timers/promises'
      let counter = 0
      export async function handler(input) {
        counter++
        await appendFile('executions.log', version + '\\n')
        if (input.hold) {
          await appendFile('started.flag', 'started')
          while (!await access('release.flag').then(() => true, () => false)) await delay(25)
        }
        return { version, counter, pid: process.pid }
      }
    `
    )
    await dependency("one")
    await manifest()
    start(["--watch"])
    await until(() => connections().length === 1, "initial connection")
    for (const artifactDirectory of [
      "tmp/brand-extraction-scorers",
      "temp",
      "artifacts",
      "test-results",
      "playwright-report",
    ]) {
      await mkdir(join(directory, artifactDirectory), { recursive: true })
      await writeFile(join(directory, artifactDirectory, "result.json"), "{}")
    }
    await delay(750)
    expect(connections()).toHaveLength(1)
    const first = await call()
    expect(first).toMatchObject({ version: "one", counter: 1 })
    await dependency("intermediate")
    await dependency("two")
    await until(() => connections().length === 2, "import reload")
    const second = await call()
    expect(second).toMatchObject({ version: "two", counter: 1 })
    expect(second.pid).not.toBe(first.pid)
    expect(connections()[1].revisions.workflow).toBe(1)
    await manifest(true)
    await until(() => connections().length === 3, "schema resync")
    expect(definitions[0].inputSchema.required).toEqual(["model"])
    expect(connections()[2].revisions.workflow).toBe(2)

    blockedId = enqueue({ hold: true, model: "model" })
    await until(
      () => existsSync(join(directory, "started.flag")),
      "active call"
    )
    await dependency("obsolete-during-drain")
    await until(() => output.includes("finishing active calls"), "draining")
    await delay(400)
    expect(connections()).toHaveLength(3)
    expect(registrations.filter((row) => row.disconnect)).toHaveLength(0)
    await writeFile(join(directory, "release.flag"), "release")
    await until(() => blockedRequests.length >= 2, "uncertain result retries")
    expect(new Set(blockedRequests).size).toBe(1)
    expect(connections()).toHaveLength(3)
    expect(results.get(blockedId)).toMatchObject({
      ok: true,
      output: { version: "two", counter: 1 },
    })
    await dependency("three")
    allowAck = true
    await until(
      () => connections().length === 5,
      "replacement after acknowledgment"
    )
    expect(registrations.filter((row) => row.disconnect)).toHaveLength(0)
    expect(await call({ model: "model" })).toMatchObject({
      version: "three",
      counter: 1,
    })
    expect(
      (await readFile(join(directory, "executions.log"), "utf8"))
        .trim()
        .split("\n")
    ).toEqual(["one", "two", "two", "three"])

    await writeFile(
      join(directory, "src/version.ts"),
      "export const version = ;"
    )
    await until(() => output.includes("Reload failed"), "invalid edit recovery")
    expect(connections()).toHaveLength(5)
    expect(await call({ model: "model" })).toMatchObject({
      version: "three",
      counter: 2,
    })
    await writeFile(
      join(directory, "src/version.tmp"),
      "export const version = 'four'"
    )
    await rename(
      join(directory, "src/version.tmp"),
      join(directory, "src/version.ts")
    )
    await until(() => connections().length === 6, "atomic save recovery")
    expect(await call({ model: "model" })).toMatchObject({
      version: "four",
      counter: 1,
    })
    const failuresBefore = output.split("Reload failed").length
    const validManifest = await readFile(
      join(directory, "datool.config.ts"),
      "utf8"
    )
    await writeFile(
      join(directory, "datool.config.ts"),
      validManifest.replace('"required":["model"]', '"required":"model"')
    )
    await until(
      () => output.split("Reload failed").length > failuresBefore,
      "invalid schema edit"
    )
    expect(connections()).toHaveLength(6)
    expect(await call({ model: "model" })).toMatchObject({
      version: "four",
      counter: 2,
    })
    await writeFile(join(directory, "datool.config.ts"), validManifest)
    await until(() => connections().length === 7, "schema edit recovery")
    await stop()

    // The single-handler path uses the same watcher and stable app ID.
    await writeFile(
      join(directory, "local.ts"),
      "export { handler as default } from './src/handler.ts'"
    )
    start(["local.ts", "--watch"])
    await until(() => connections().length === 8, "single handler")
    const handlerId = definitions[0].id
    expect(await call({}, handlerId)).toMatchObject({
      version: "four",
      counter: 1,
    })
    await dependency("five")
    await until(() => connections().length === 9, "single handler import")
    expect(definitions[0].id).toBe(handlerId)
    expect(await call({}, handlerId)).toMatchObject({
      version: "five",
      counter: 1,
    })
    await stop()

    start(["local.ts", "--no-watch"])
    await until(() => connections().length === 10, "no-watch")
    await dependency("six")
    expect(await call({}, handlerId)).toMatchObject({
      version: "five",
      counter: 1,
    })
    expect(connections()).toHaveLength(10)
    await stop()
    const registeredBeforeWebhook = connections().length
    start(["https://example.test/webhook"])
    await once(child!, "exit")
    expect(child!.exitCode).toBe(0)
    expect(output).toContain("HTTP app registered")
    expect(connections()).toHaveLength(registeredBeforeWebhook)
    expect(definitions[0]).toMatchObject({
      connection: { type: "webhook", url: "https://example.test/webhook" },
    })
  } finally {
    await stop()
    server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { BridgeJob, BridgeResult } from "../src/lib/playground/connections"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connectOptions } from "../bin/connect-options"
import { parseAppManifest } from "../bin/app-bridge"
import { serveWebhook } from "../src/server/apps/webhook"
import type { AppConfig, AppDefinition } from "../src/lib/playground/contracts"

const entry = {
  id: "echo",
  name: "Echo",
  inputSchema: { type: "object" },
  outputSchema: {},
  handler: (input: { text: string }) => input,
}

test("connect discovers the project manifest and parses options without a target", () => {
  expect(connectOptions([], "/project", "/project/src")).toEqual({
    target: "/project/datool.config.ts",
    defaultManifest: true,
    watch: false,
    mode: "input",
    name: undefined,
  })
  expect(
    connectOptions(["--name", "Agent", "--mode", "agent"], "/project")
  ).toMatchObject({
    target: "/project/datool.config.ts",
    mode: "agent",
    name: "Agent",
  })
  expect(
    connectOptions(
      ["--mode", "workflow", "custom.ts"],
      "/project",
      "/project/src"
    )
  ).toMatchObject({
    target: "/project/src/custom.ts",
    defaultManifest: false,
    mode: "input",
  })
  expect(
    connectOptions(["https://example.test/call", "--mode", "input"], "/project")
      .target
  ).toBe("https://example.test/call")
  for (const args of [
    ["--name"],
    ["--mode", "invalid"],
    ["a.ts", "b.ts"],
    ["--unknown"],
  ])
    expect(() => connectOptions(args, "/project")).toThrow()
})

test("workflow and agent manifest types normalize to compatible invocation modes", () => {
  for (const [options, mode] of [
    [{}, "input"],
    [{ type: "workflow" }, "input"],
    [{ type: "agent" }, "agent"],
    [{ mode: "input" }, "input"],
    [{ mode: "agent" }, "agent"],
    [{ type: "agent", mode: "agent" }, "agent"],
  ] as const) {
    const [app] = parseAppManifest({ apps: [{ ...entry, ...options }] })
    expect(app.mode).toBe(mode)
    expect(app.handler).toBe(entry.handler)
  }
})

test("manifest schemas can retain their $id across validation and edits", () => {
  const app = {
    ...entry,
    inputSchema: { $id: "urn:datool:watch-input", type: "object" },
  }
  parseAppManifest({ apps: [app] })
  expect(parseAppManifest({ apps: [app] })).toHaveLength(1)
  expect(
    parseAppManifest({
      apps: [
        { ...app, inputSchema: { ...app.inputSchema, required: ["model"] } },
      ],
    })
  ).toHaveLength(1)
})

test("invalid manifests fail before registration", () => {
  const invalid = [
    { apps: [] },
    { apps: [entry, entry] },
    { apps: [{ ...entry, type: "tool" }] },
    { apps: [{ ...entry, type: "agent", mode: "input" }] },
    { apps: [{ ...entry, handler: undefined }] },
    { apps: [{ ...entry, flushTelemetry: true }] },
    { apps: [{ ...entry, inputSchema: {} }] },
    { apps: [{ ...entry, inputSchema: { type: "object", required: "bad" } }] },
    { apps: [{ ...entry, outputSchema: { type: "not-a-type" } }] },
  ]
  for (const config of invalid)
    expect(() => parseAppManifest(config as AppConfig)).toThrow()
})

test("connect receives outbound jobs, retries uncertain claims, and resyncs revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-connect-"))
  const binary =
    process.env.DATOOL_TEST_CLI_BINARY ??
    fileURLToPath(new URL("../bin/datool.ts", import.meta.url))
  const requests: string[] = []
  let definitions: AppDefinition[] = []
  let registration:
    | {
        transport: string
        token: string
        revisions: Record<string, number>
        disconnect?: boolean
      }
    | undefined
  const jobs: BridgeJob[] = []
  const claims = new Map<string, BridgeJob[]>()
  const results = new Map<string, BridgeResult>()
  let lostClaim = false
  let denySync = false
  let child: ChildProcessWithoutNullStreams | undefined
  const server = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    expect(request.headers.get("authorization")).toBe(
      "Bearer dtk_connect_fixture"
    )
    expect(request.headers.get("x-project-id")).toBe("connect-fixture")
    if (path === "/api/apps/config" && request.method === "POST") {
      if (denySync)
        return Response.json(
          { error: { message: "Unavailable" } },
          { status: 503 }
        )
      definitions = (
        (await request.json()) as Omit<AppDefinition, "revision">[]
      ).map((app) => {
        const previous = definitions.find((saved) => saved.id === app.id)
        const { revision = 0, ...prior } = previous ?? {}
        return {
          ...app,
          revision:
            revision + (JSON.stringify(prior) === JSON.stringify(app) ? 0 : 1),
        }
      })
      return Response.json({ data: definitions })
    }
    if (path === "/api/apps/bridges" && request.method === "POST") {
      registration = await request.json()
      return Response.json({ data: { transport: "relay", protocolVersion: 2 } })
    }
    if (path === "/api/apps/bridges/exchange") {
      const body = await request.json()
      const claimed =
        claims.get(body.requestId) ?? jobs.splice(0, Math.min(body.capacity, 1))
      claims.set(body.requestId, claimed)
      for (const item of body.results) results.set(item.id, item.result)
      if (claimed.length && !lostClaim) {
        lostClaim = true
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
  const origin = `http://127.0.0.1:${server.port}`
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("DATOOL_") && key !== "NODE_OPTIONS"
    )
  )
  async function manifest(name = "Workflow", file = "datool.config.ts") {
    await writeFile(
      join(directory, file),
      `export default { apps: [
      { id: "workflow", name: ${JSON.stringify(name)}, type: "workflow", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: input => ({ text: input.text.toUpperCase() }) },
      { id: "agent", name: "Agent", type: "agent", inputSchema: { type: "object", properties: { messages: { type: "array" } } }, outputSchema: { type: "string" }, handler: messages => messages.at(-1).content }
    ] }`
    )
  }
  function start(args: string[] = [], cwd = directory, success = true) {
    const runtime = process.env.DATOOL_TEST_CLI_BINARY
      ? "node"
      : process.execPath
    child = spawn(
      runtime,
      [
        ...(runtime === "node" ? [] : ["--no-env-file"]),
        binary,
        "connect",
        ...args,
      ],
      {
        cwd,
        env: {
          ...env,
          NODE_ENV: "test",
          DATOOL_CONFIG_DIR: join(directory, "credentials"),
        },
        stdio: "pipe",
      }
    )
    let output = ""
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`connect timed out: ${output}`)),
        15000
      )
      const collect = (chunk: Buffer) => {
        output += chunk.toString()
        if (success && output.includes("Listening for ")) {
          clearTimeout(timer)
          resolve(output)
        }
      }
      child!.stdout.on("data", collect)
      child!.stderr.on("data", collect)
      child!.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child!.once("exit", (code) => {
        clearTimeout(timer)
        if (!success && code !== 0) resolve(output)
        else reject(new Error(`Unexpected connect exit ${code}: ${output}`))
      })
    })
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
  }
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await mkdir(join(directory, "src"))
    await writeFile(
      join(directory, ".env.local"),
      `DATOOL_BASE_URL=${origin}\nDATOOL_PROJECT_ID=connect-fixture\nDATOOL_API_KEY=dtk_connect_fixture\n`
    )
    await manifest()
    const first = await start()
    expect(first).toContain("workflow workflow, agent agent")
    expect(requests.slice(0, 2)).toEqual([
      "POST /api/apps/config",
      "POST /api/apps/bridges",
    ])
    expect(registration!.revisions).toEqual({ workflow: 1, agent: 1 })
    expect(JSON.stringify(definitions)).not.toContain("handler")
    expect(registration!.transport).toBe("relay")
    expect(Object.hasOwn(registration!, "url")).toBe(false)
    for (const [appId, input, output] of [
      ["workflow", { text: "hello" }, { text: "HELLO" }],
      [
        "agent",
        { messages: [{ role: "user", content: "hello agent" }] },
        "hello agent",
      ],
    ] as const) {
      const id = randomUUID()
      jobs.push({
        id,
        appId,
        input,
        callId: randomUUID(),
        deadline: Date.now() + 12000,
      })
      const deadline = Date.now() + 12000
      while (!results.has(id) && Date.now() < deadline) await delay(25)
      expect(results.get(id)).toEqual({
        ok: true,
        output,
        telemetryComplete: false,
      })
    }
    expect(lostClaim).toBe(true)
    await stop()
    expect(registration!.disconnect).toBe(true)

    await start(
      ["--datool", origin, "--project", "connect-fixture"],
      join(directory, "src")
    )
    expect(registration!.revisions).toEqual({ workflow: 1, agent: 1 })
    await stop()
    await manifest("Changed workflow")
    await start()
    expect(registration!.revisions).toEqual({ workflow: 2, agent: 1 })
    await stop()
    await manifest("Explicit workflow", "custom.ts")
    await start(["custom.ts"])
    expect(registration!.revisions.workflow).toBe(3)
    await stop()

    const beforeDenied = requests.length
    denySync = true
    expect(await start([], directory, false)).toContain("HTTP 503")
    expect(requests.slice(beforeDenied)).toEqual(["POST /api/apps/config"])
    await writeFile(
      join(directory, "datool.config.ts"),
      'export default { apps: [{ id: "bad", name: "Bad", inputSchema: {type:"object"}, outputSchema: {} }] }'
    )
    const beforeInvalid = requests.length
    expect(await start([], directory, false)).toContain("Missing handler")
    expect(requests.length).toBe(beforeInvalid)
    await rm(join(directory, "datool.config.ts"))
    expect(await start([], directory, false)).toContain("No manifest found")
    expect(requests.length).toBe(beforeInvalid)
  } finally {
    await stop()
    server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)

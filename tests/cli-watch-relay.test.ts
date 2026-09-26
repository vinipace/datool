import { expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import { createPlaygroundStorage } from "../src/server/playground/storage"
import { withWorkspace } from "../src/server/auth/context"
import { createRelay, BridgeConflict } from "../src/server/apps/relay"
import { createAppCatalog } from "../src/server/apps/catalog"
import { serveWebhook } from "../src/server/apps/webhook"

test("real relay preserves queued and arriving calls across watched reload, lost acknowledgments and telemetry flush", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const pool = new Pool({ connectionString: target.databaseUrl })
  const identity = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    kind: "api-key" as const,
    scopes: ["apps:read", "apps:write"],
  }
  const storage = createPlaygroundStorage(pool)
  const relay = createRelay(pool, storage)
  const catalog = createAppCatalog(storage)
  const directory = await mkdtemp(join(tmpdir(), "datool-watch-relay-"))
  let registrations = 0
  const registeredTokens = new Set<string>()
  let lostRegistration = false
  const calls: ReturnType<typeof relay.invoke>[] = []
  let acknowledgments = 0
  let loseAcknowledgments = true
  let output = ""
  const requests = new Set<string>()
  const server = await serveWebhook((request) =>
    withWorkspace(identity, async () => {
      try {
        const body = await request.json()
        const path = new URL(request.url).pathname
        let data
        if (path === "/api/apps/config") data = await catalog.registerApps(body)
        else if (path === "/api/apps/bridges") {
          data = await relay.register(body)
          if (!body.disconnect && !registeredTokens.has(body.token)) {
            registeredTokens.add(body.token)
            registrations++
          }
          if (body.resumeToken && !lostRegistration) {
            lostRegistration = true
            return Response.json({ error: {} }, { status: 503 })
          }
        } else {
          data = await relay.exchange(body)
          if (body.results.length && loseAcknowledgments) {
            acknowledgments++
            requests.add(body.requestId)
            return Response.json({ error: {} }, { status: 503 })
          }
        }
        return Response.json({ data })
      } catch (error) {
        return Response.json(
          { error: { message: String(error) } },
          { status: error instanceof BridgeConflict ? 409 : 500 }
        )
      }
    })
  )
  const binary =
    process.env.DATOOL_TEST_CLI_BINARY ?? join(process.cwd(), "bin/datool.ts")
  const runtime =
    process.env.DATOOL_TEST_CLI_RUNTIME ??
    (process.env.DATOOL_TEST_CLI_BINARY ? "node" : process.execPath)
  let child: ReturnType<typeof spawn> | undefined
  async function until(
    predicate: () => boolean | Promise<boolean>,
    label: string
  ) {
    const deadline = Date.now() + 20000
    while (!(await predicate())) {
      if (Date.now() > deadline || child?.exitCode != null)
        throw new Error(`${label}\n${output}`)
      await delay(25)
    }
  }
  const lines = async () =>
    (await readFile(join(directory, "executions.log"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
  const invoke = (id: string) =>
    withWorkspace(identity, async () => {
      const state = await storage.readState()
      return relay.invoke(
        state.bridges[0].id,
        "watch-echo",
        { id },
        randomUUID(),
        undefined,
        60000
      )
    })
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await mkdir(join(directory, "src"))
    await writeFile(
      join(directory, "src/version.ts"),
      "export const version = 'one'"
    )
    await writeFile(
      join(directory, "datool.config.ts"),
      `
      import { version } from './src/version.ts'
      import { appendFile, access } from 'node:fs/promises'
      const wait = async file => { while (!await access(file).then(()=>true,()=>false)) await new Promise(r=>setTimeout(r,25)) }
      export default { apps: [{ id:'watch-echo', name:'Watch echo', inputSchema:{type:'object'}, outputSchema:{type:'object'},
        handler: async input => { await appendFile('executions.log', input.id + ':' + version + '\\n'); await wait('release.flag'); return { id:input.id, version } },
        flushTelemetry: async () => { await appendFile('flushing.flag', 'flush'); await wait('flushed.flag') }
      }] }
    `
    )
    // A real app checkout changes code provenance on save. That must not make
    // otherwise compatible queued calls fail during the handoff.
    await writeFile(join(directory, ".gitignore"), "*.flag\n*.log\n")
    execFileSync("git", ["init", "--quiet"], { cwd: directory })
    execFileSync("git", ["add", "."], { cwd: directory })
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Relay fixture",
        "-c",
        "user.email=relay@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Initial handler",
      ],
      { cwd: directory }
    )
    child = spawn(
      runtime,
      [
        ...(runtime.includes("bun") ? ["--no-env-file"] : []),
        binary,
        "connect",
        "--watch",
        "--no-env",
      ],
      {
        cwd: directory,
        stdio: "pipe",
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          DATOOL_CONFIG_DIR: directory,
          DATOOL_BASE_URL: `http://127.0.0.1:${server.port}`,
          DATOOL_PROJECT_ID: target.projectId,
          DATOOL_API_KEY: "dtk_watch_fixture",
        },
      }
    )
    child.stdout!.on("data", (data) => {
      output += data
    })
    child.stderr!.on("data", (data) => {
      output += data
    })
    await until(() => registrations === 1, "initial listener")
    calls.push(...Array.from({ length: 20 }, (_, i) => invoke(String(i))))
    await until(
      async () => (await lines()).length === 16,
      "16 active and 4 queued calls"
    )
    await writeFile(
      join(directory, "src/version.ts"),
      "export const version = 'two'"
    )
    await until(
      () => output.includes("finishing active calls"),
      "reload begins"
    )
    calls.push(invoke("during-reload"))
    await writeFile(join(directory, "release.flag"), "ok")
    await until(
      () => existsSync(join(directory, "flushing.flag")),
      "telemetry flush"
    )
    await delay(300)
    expect(registrations).toBe(1)
    await writeFile(join(directory, "flushed.flag"), "ok")
    await until(() => acknowledgments >= 2, "lost acknowledgment retried")
    expect(requests.size).toBe(1)
    expect(registrations).toBe(1)
    loseAcknowledgments = false
    await until(() => registrations === 2, "replacement listener")
    const results = await Promise.all(calls)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(lostRegistration).toBe(true)
    const state = await withWorkspace(identity, () => storage.readState())
    expect(state.apps[0].revision).toBe(2)
    expect(state.apps[0].codeProvenance).toMatchObject({
      source: "local-git",
      dirty: true,
    })
    const executions = await lines()
    expect(executions).toHaveLength(21)
    expect(new Set(executions.map((line) => line.split(":")[0])).size).toBe(21)
    expect(executions.filter((line) => line.endsWith(":one"))).toHaveLength(16)
    expect(executions.filter((line) => line.endsWith(":two"))).toHaveLength(5)
    const saved = await pool.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE result->>'ok'='true')::int AS succeeded FROM app_bridge_job"
    )
    expect(saved.rows[0]).toEqual({ total: 21, succeeded: 21 })
  } catch (error) {
    console.error(error, output)
    throw error
  } finally {
    loseAcknowledgments = false
    await writeFile(join(directory, "release.flag"), "ok")
    await writeFile(join(directory, "flushed.flag"), "ok")
    if (child && child.exitCode === null) {
      child.kill("SIGTERM")
      await Promise.race([once(child, "exit"), delay(5000)])
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    server.stop()
    await pool.query(
      "UPDATE app_bridge_job SET result=$1 WHERE result IS NULL",
      [JSON.stringify({ ok: false, error: "Test cleanup" })]
    )
    await Promise.allSettled(calls)
    await pool.end()
    await target.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 90000)

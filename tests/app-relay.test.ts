import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import { createPlaygroundStorage } from "../src/server/playground/storage"
import {
  withWorkspace,
  type WorkspaceIdentity,
} from "../src/server/auth/context"
import { createRelay } from "../src/server/apps/relay"
import { createAppCatalog } from "../src/server/apps/catalog"
import { resolveRegisteredApp } from "../src/server/apps/invoke"
import { invokeConnection } from "../src/server/apps/store"
import { serveWebhook } from "../src/server/apps/webhook"
import { invokeHttp, publicAddress } from "../src/server/apps/http-transport"
import {
  appConnectionSchema,
  webhookConnectionSchema,
} from "../src/lib/playground/connections"

const definition = {
  id: "echo",
  name: "Echo",
  mode: "input",
  inputSchema: { type: "object" },
  outputSchema: {},
  evaluatorIds: [],
  internalTracing: false,
}
async function fixture() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const pool = new Pool({ connectionString: target.databaseUrl })
  const identity: WorkspaceIdentity = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    kind: "api-key",
    scopes: ["apps:read", "apps:write"],
  }
  const storage = createPlaygroundStorage(pool, async () => ({
    apps: [],
    bridges: [],
    playgrounds: [],
    attempts: [],
  }))
  return {
    ...target,
    pool,
    identity,
    storage,
    async close() {
      await pool.end()
      await target.close()
    },
  }
}

test("relay jobs survive separate server instances; claims and results are idempotent and project scoped", async () => {
  const f = await fixture()
  try {
    await withWorkspace(f.identity, async () => {
      const catalog = createAppCatalog(f.storage)
      await catalog.registerApps([definition])
      expect((await catalog.registerApps([definition]))[0].revision).toBe(1)
      const a = createRelay(f.pool, f.storage)
      const b = createRelay(f.pool, createPlaygroundStorage(f.pool))
      const session = {
        id: randomUUID(),
        token: randomUUID(),
        appIds: ["echo"],
        revisions: { echo: 1 },
        transport: "relay" as const,
      }
      await a.register(session)
      expect((await catalog.listApps())[0].online).toBe(true)
      expect(JSON.stringify(await f.storage.readState())).not.toContain(
        session.token
      )
      const callId = randomUUID()
      const invocation = a.invoke(
        session.id,
        "echo",
        { text: "hello" },
        callId,
        "trace-fixture",
        5000
      )
      const poll = {
        id: session.id,
        token: session.token,
        requestId: randomUUID(),
        capacity: 1,
        results: [],
      }
      let first = await b.exchange(poll)
      while (!first.jobs.length) {
        await delay(10)
        first = await b.exchange(poll)
      }
      expect(first.jobs[0]).toMatchObject({
        appId: "echo",
        input: { text: "hello" },
        callId,
        traceId: "trace-fixture",
      })
      expect((await a.exchange(poll)).jobs).toEqual(first.jobs)
      expect(
        (await b.exchange({ ...poll, requestId: randomUUID() })).jobs
      ).toEqual([])
      await rejects(
        b.exchange({ ...poll, token: randomUUID() }),
        /Unknown bridge/
      )
      const result = {
        ok: true as const,
        output: { text: "HELLO" },
        telemetryComplete: true,
      }
      const completed = {
        ...poll,
        requestId: randomUUID(),
        results: [{ id: first.jobs[0].id, result }],
      }
      expect((await b.exchange(completed)).acknowledged).toEqual([
        first.jobs[0].id,
      ])
      expect(await invocation).toEqual(result)
      expect((await a.exchange(completed)).acknowledged).toEqual([
        first.jobs[0].id,
      ])
      await rejects(
        a.exchange({
          ...completed,
          results: [
            { id: first.jobs[0].id, result: { ...result, output: "changed" } },
          ],
        }),
        /conflicting/
      )
      await rejects(
        a.invoke(session.id, "echo", {}, callId),
        /already dispatched/
      )
      // An alternate project cannot access the session, even with its exact token.
      await rejects(
        withWorkspace({ ...f.identity, projectId: "other" }, () =>
          b.exchange(poll)
        )
      )
      const timedOut = rejects(
        a.invoke(session.id, "echo", {}, randomUUID(), undefined, 750),
        /timed out/
      )
      let claimed = await b.exchange({ ...poll, requestId: randomUUID() })
      while (!claimed.jobs.length) {
        await delay(10)
        claimed = await b.exchange({ ...poll, requestId: randomUUID() })
      }
      await timedOut
      expect(
        (await b.exchange({ ...poll, requestId: randomUUID() })).jobs
      ).toEqual([])
      expect(
        (
          await b.exchange({
            ...poll,
            requestId: randomUUID(),
            results: [{ id: claimed.jobs[0].id, result }],
          })
        ).acknowledged
      ).toEqual([claimed.jobs[0].id])
      await f.storage.mutate((state) => {
        state.bridges[0].expiresAt = Date.now() - 1
      })
      expect((await catalog.listApps())[0].online).toBe(false)
      await rejects(a.invoke(session.id, "echo", {}, randomUUID()), /offline/)
      await a.register({ ...session, disconnect: true })
      expect((await catalog.listApps())[0].online).toBe(false)
    })
  } finally {
    await f.close()
  }
}, 20000)

test("HTTP apps remain available, hide encrypted headers, preserve them on edit, and invoke without a bridge", async () => {
  const f = await fixture()
  const priorSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "fixture-secret-only-for-app-connections-12345"
  let expectedMethod = "POST"
  const server = await serveWebhook(async (request) => {
    expect(request.method).toBe(expectedMethod)
    expect(request.headers.get("authorization")).toBe("Bearer fixture-secret")
    expect(request.headers.get("x-datool-call-id")).toBe("call-fixture")
    return Response.json({ received: await request.json() })
  })
  try {
    await withWorkspace(f.identity, async () => {
      const catalog = createAppCatalog(f.storage)
      const connection = {
        type: "webhook",
        url: `http://127.0.0.1:${server.port}/call`,
        headers: { Authorization: "Bearer fixture-secret" },
      }
      const [saved] = await catalog.registerApps([
        { ...definition, connection, expectedRevision: 0 },
      ])
      expect(saved.revision).toBe(1)
      const [unchanged] = await catalog.registerApps([
        { ...definition, connection, expectedRevision: 1 },
      ])
      expect(unchanged.revision).toBe(1)
      const publicApps = await catalog.listApps()
      expect(publicApps[0].online).toBe(true)
      expect(JSON.stringify(publicApps)).not.toContain("fixture-secret")
      expect(JSON.stringify(await f.storage.readState())).not.toContain(
        "fixture-secret"
      )
      const app = resolveRegisteredApp(await f.storage.readState(), "echo")!
      expect(
        await invokeConnection(
          app.connection,
          { input: { text: "hello" } },
          "call-fixture"
        )
      ).toEqual({ received: { text: "hello" } })
      const publicConfig = { type: connection.type, url: connection.url }
      await catalog.registerApps([
        {
          ...definition,
          connection: { ...publicConfig, method: "PUT", body: "envelope" },
          expectedRevision: 1,
        },
      ])
      expectedMethod = "PUT"
      const edited = resolveRegisteredApp(await f.storage.readState(), "echo")!
      expect(
        await invokeConnection(
          edited.connection,
          { input: { text: "hello" } },
          "call-fixture"
        )
      ).toEqual({ received: { input: { text: "hello" } } })
      await rejects(
        catalog.registerApps([{ ...definition, expectedRevision: 1 }]),
        /App changed/
      )
      const bridge = createRelay(f.pool, f.storage)
      await rejects(
        bridge.register({
          id: randomUUID(),
          token: randomUUID(),
          appIds: ["echo"],
          revisions: { echo: 2 },
          transport: "relay",
        }),
        /HTTP apps/
      )
      await catalog.registerApps([
        {
          ...definition,
          connection: { ...publicConfig, headers: {} },
          expectedRevision: 2,
        },
      ])
      expect((await catalog.listApps())[0].connection).toMatchObject({
        headerNames: [],
      })
    })
  } finally {
    server.stop()
    if (priorSecret === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = priorSecret
    await f.close()
  }
}, 20000)

test("webhook configuration rejects unsupported transports, credential URLs and managed headers", () => {
  for (const connection of [
    { type: "future" },
    { type: "webhook", url: "file:///tmp/a" },
    { type: "webhook", url: "https://user:password@example.com" },
    {
      type: "webhook",
      url: "https://example.com",
      headers: { Host: "localhost" },
    },
    {
      type: "webhook",
      url: "https://example.com",
      headers: { Authorization: "a\nb" },
    },
  ])
    expect(appConnectionSchema.safeParse(connection).success).toBe(false)
  for (const ip of [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
  ])
    expect(publicAddress(ip)).toBe(false)
  expect(publicAddress("8.8.8.8")).toBe(true)
  expect(publicAddress("2606:4700::1111")).toBe(true)
})

test("HTTP failures and redirects do not replay calls or expose response secrets", async () => {
  let calls = 0
  const server = await serveWebhook(async (request) => {
    calls++
    const url = new URL(request.url)
    if (url.pathname === "/slow") {
      await delay(1500)
      return Response.json({ tooLate: true })
    }
    return new Response("private upstream error", {
      status: 302,
      headers: { location: "/target" },
    })
  })
  try {
    const config = webhookConnectionSchema.parse({
      type: "webhook",
      url: `http://127.0.0.1:${server.port}/redirect`,
      timeoutMs: 1000,
    })
    const context = { appId: "fixture", callId: randomUUID() }
    await rejects(
      invokeHttp(config, {}, {}, context),
      /^Error: Webhook returned HTTP 302$/
    )
    expect(calls).toBe(1)
    await rejects(
      invokeHttp(
        { ...config, url: `http://127.0.0.1:${server.port}/slow` },
        {},
        {},
        context
      ),
      /failed or timed out/
    )
    expect(calls).toBe(2)
  } finally {
    server.stop()
  }
})

test("a CLI handler receives a durable relay job and its output becomes a saved playground experiment", async () => {
  const { spawn } = await import("node:child_process")
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { relay } = await import("../src/server/apps/relay")
  const { createTracerDatabase, closeTracerDatabase } =
    await import("../src/server/tracer/db")
  const { TracerService, recoverInterruptedEvalRuns } =
    await import("../src/server/tracer/service")
  const { runTracerEffect } = await import("../src/server/tracer/effect")
  const { runAppExperiment } = await import("../src/server/apps/scoring")
  const f = await fixture()
  const directory = await mkdtemp(join(tmpdir(), "datool-relay-e2e-"))
  const database = createTracerDatabase(f.databaseUrl, {
    projectId: f.projectId,
    schema: f.schema,
  })
  const catalog = createAppCatalog(f.storage)
  const bridge = createRelay(f.pool, f.storage)
  const previousInvoke = relay.invoke
  relay.invoke = bridge.invoke
  let child: import("node:child_process").ChildProcess | undefined
  const server = await serveWebhook((request) =>
    withWorkspace(f.identity, async () => {
      expect(request.headers.get("x-project-id")).toBe(f.projectId)
      expect(request.headers.get("authorization")).toBe("Bearer dtk_fixture")
      const body = await request.json()
      const path = new URL(request.url).pathname
      const value =
        path === "/api/apps/config"
          ? await catalog.registerApps(body)
          : path === "/api/apps/bridges"
            ? await bridge.register(body)
            : await bridge.exchange(body)
      return Response.json({ data: value })
    })
  )
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await writeFile(
      join(directory, "datool.config.ts"),
      `export default { apps: [{
      id: "echo", name: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" },
      handler: async input => { await new Promise(resolve => setTimeout(resolve, 200)); return { text: input.text.toUpperCase() } }
    }] }`
    )
    child = spawn(
      process.execPath,
      [
        "--no-env-file",
        `${process.cwd()}/bin/datool.ts`,
        "connect",
        "--no-env",
      ],
      {
        cwd: directory,
        stdio: "pipe",
        env: {
          ...process.env,
          DATOOL_BASE_URL: `http://127.0.0.1:${server.port}`,
          DATOOL_PROJECT_ID: f.projectId,
          DATOOL_API_KEY: "dtk_fixture",
          DATOOL_CONFIG_DIR: directory,
        },
      }
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CLI did not connect")),
        8000
      )
      child!.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("Listening for")) {
          clearTimeout(timer)
          resolve()
        }
      })
      child!.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`CLI exited ${code}`))
      })
    })
    await withWorkspace(f.identity, async () => {
      const service = new TracerService(database, {
        resolveApp: async (id) =>
          resolveRegisteredApp(await f.storage.readState(), id)!,
      })
      const app = resolveRegisteredApp(await f.storage.readState(), "echo")!
      const executing = runAppExperiment(
        service,
        app,
        { text: "remote to local" },
        {}
      )
      let rows = await f.pool.query(
        "SELECT r.id FROM eval_runs r JOIN eval_run_lease l ON l.run_id=r.id WHERE r.project_id=$1",
        [f.projectId]
      )
      while (!rows.rowCount) {
        await delay(10)
        rows = await f.pool.query(
          "SELECT r.id FROM eval_runs r JOIN eval_run_lease l ON l.run_id=r.id WHERE r.project_id=$1",
          [f.projectId]
        )
      }
      // A cold server instance must not finalize an active run owned by another instance.
      await f.pool.query("UPDATE eval_runs SET created_at=$2 WHERE id=$1", [
        rows.rows[0].id,
        new Date(Date.now() - 120000).toISOString(),
      ])
      await recoverInterruptedEvalRuns(database, { staleOnly: true })
      const { experiment, trace } = await executing
      expect(experiment.status).toBe("completed")
      expect(trace.output).toEqual({ text: "REMOTE TO LOCAL" })
      expect(trace.attributes["datool.connection.id"]).toBe("echo")
      expect(
        (await runTracerEffect(service.getEvalRun(experiment.id))).status
      ).toBe("completed")
      expect(
        (await runTracerEffect(service.getTraceArtifact(trace.id))).output
      ).toEqual(trace.output)
    })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    relay.invoke = previousInvoke
    server.stop()
    await closeTracerDatabase(database)
    await f.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)

test("protocol 2 receipts replay empty polls, claims and stored acknowledgments exactly", async () => {
  const f = await fixture()
  try {
    await withWorkspace(f.identity, async () => {
      await createAppCatalog(f.storage).registerApps([definition])
      const relay = createRelay(f.pool, f.storage)
      const session = {
        id: randomUUID(),
        token: randomUUID(),
        appIds: ["echo"],
        revisions: { echo: 1 },
        transport: "relay" as const,
        protocolVersion: 2 as const,
      }
      await relay.register(session)
      expect(
        (await f.storage.readState()).bridges[0].expiresAt - Date.now()
      ).toBeGreaterThan(120_000)
      const empty = {
        id: session.id,
        token: session.token,
        requestId: randomUUID(),
        capacity: 1,
        results: [],
      }
      expect((await relay.exchange(empty)).jobs).toEqual([])
      const invoked = relay.invoke(
        session.id,
        "echo",
        { value: 1 },
        randomUUID(),
        undefined,
        5_000
      )
      let reply: Awaited<ReturnType<typeof relay.exchange>> = {
        jobs: [],
        acknowledged: [],
      }
      let claim = empty
      while (!reply.jobs.length) {
        expect((await relay.exchange(empty)).jobs).toEqual([])
        claim = { ...empty, requestId: randomUUID() }
        reply = await relay.exchange(claim)
        if (!reply.jobs.length) await delay(10)
      }
      expect(reply.jobs[0].executionTimeoutMs).toBe(5_000)
      expect(reply.jobs[0].deadline - Date.now()).toBeGreaterThan(300_000)
      expect(await relay.exchange(claim)).toEqual(reply)
      await rejects(
        relay.exchange({ ...claim, capacity: 0 }),
        /different content/
      )
      const result = {
        ok: true as const,
        output: { saved: true },
        telemetryComplete: true,
      }
      const completed = {
        ...empty,
        requestId: randomUUID(),
        results: [{ id: reply.jobs[0].id, result }],
      }
      const ack = await relay.exchange(completed)
      expect(await invoked).toEqual(result)
      expect(await relay.exchange(completed)).toEqual(ack)
      expect((await relay.exchange(claim)).jobs).toEqual(reply.jobs)
      await f.pool.query(
        "UPDATE app_bridge_job SET deadline=now()-interval '1 hour' WHERE id=$1",
        [reply.jobs[0].id]
      )
      expect(
        (await relay.exchange({ ...completed, requestId: randomUUID() }))
          .acknowledged
      ).toEqual([reply.jobs[0].id])
      expect(
        (
          await f.pool.query("SELECT result FROM app_bridge_job WHERE id=$1", [
            reply.jobs[0].id,
          ])
        ).rows[0].result
      ).toEqual(result)
      await rejects(
        relay.exchange({
          ...completed,
          requestId: randomUUID(),
          results: [
            {
              id: reply.jobs[0].id,
              result: { ...result, output: "different" },
            },
          ],
        }),
        /conflicting/
      )
      await f.storage.mutate((state) => {
        state.bridges[0].expiresAt = Date.now() - 1
      })
      await relay.register({
        ...session,
        id: randomUUID(),
        token: randomUUID(),
      })
      await rejects(relay.exchange(completed), /Unknown bridge|replaced/)
    })
  } finally {
    await f.close()
  }
}, 20_000)

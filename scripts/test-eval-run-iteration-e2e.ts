/** Real CLI + MCP over HTTP, against a disposable loopback PostgreSQL schema. */
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { makeSignature } from "better-auth/crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import {
  permissionStatements,
  workspaceScopes,
} from "../src/lib/auth/permissions"
import { serveWebhook } from "../src/server/apps/webhook"
import { defaultScorer } from "../src/lib/tracer/scorers"
import type { EvalRunDetail } from "../src/lib/tracer/contracts"

const root = process.cwd()
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-eval-iteration-"))
const appDirectory = join(directory, "app")
const keep = process.argv.includes("--keep")
const target = await createIsolatedPostgres()
let server: ChildProcess | undefined
let judge: Awaited<ReturnType<typeof serveWebhook>> | undefined
let pools: typeof import("../lib/db") | undefined
const clients: Client[] = []
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const checks: string[] = []
function passed(message: string) {
  checks.push(message)
  console.info("PASS " + message)
}
async function port() {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const selected = (socket.address() as import("node:net").AddressInfo).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return selected
}
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const base = `http://127.0.0.1:${await port()}`
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "isolated-ai-review-test-secret-123456789",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: "development",
  })
  judge = await serveWebhook(async (request) => {
    const body = await request.json()
    if (!body.messages) return Response.json(body.input ?? body)
    const bad = JSON.parse(body.messages.at(-1).content).bad === true
    return Response.json({
      model: "test",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              choice: bad ? "Fail" : "Pass",
              reason: bad ? "Count does not match source" : "Matches source",
            }),
          },
        },
      ],
    })
  })
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${judge.port}`
  process.env.OPENAI_API_KEY = "disposable-mock-judge-key"
  // Keep inherited service credentials and user env files out of the fixture server.
  for (const key of [
    "DATOOL_API_KEY",
    "DATOOL_PROJECT_ID",
    "REDIS_URL",
    "DATOOL_DIST_DIR",
    "ANALYTICS_DATABASE_URL",
  ])
    delete process.env[key]
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const scopes = workspaceScopes
  const key = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "AI review test key",
      permissions: permissionStatements(scopes),
      rateLimitMax: 10000,
    },
  })
  const reader = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Review read-only",
      permissions: permissionStatements(["reviews:read"]),
      rateLimitMax: 10000,
    },
  })
  await pools.db.query(
    `insert into traces(id,project_id,name,operation,status,started_at,input_json,output_json)
    values ('brand-test',$1,'Separate brand extraction test','test','completed',$2,'{"response":"No brands are mentioned"}','"Unsupported brand"')`,
    [target.projectId, new Date().toISOString()]
  )
  await pools.db.query(
    `insert into project(id,organization_id,name,slug) values ('other-review-project',$1,'Other test project','other-test')`,
    [target.organizationId]
  )
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(target.ownerId)
  assert(session)
  await pools.db.query(
    'update session set "activeOrganizationId"=$1 where id=$2',
    [target.organizationId, session.id]
  )
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  await mkdir(appDirectory)
  for (const path of [
    "app",
    "components",
    "lib",
    "src",
    "cms",
    "content",
    ".source",
    "public",
    "package.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
    "postcss.config.mjs",
    "payload.config.ts",
    "payload-types.ts",
    "source.config.ts",
    "proxy.ts",
  ])
    await cp(join(root, path), join(appDirectory, path), { recursive: true })
  await symlink(
    join(root, "node_modules"),
    join(appDirectory, "node_modules"),
    "dir"
  )
  // This route exists only in the disposable copy, for browser inspection of fixture data.
  await mkdir(join(appDirectory, "app", "review-test-login"), {
    recursive: true,
  })
  await writeFile(
    join(appDirectory, "app", "review-test-login", "route.ts"),
    `export function GET(){return new Response(null,{status:302,headers:{"set-cookie":${JSON.stringify(cookie + "; Path=/; HttpOnly; SameSite=Lax")},location:"/p/test-project/evals"}})}`,
    { mode: 0o600 }
  )
  server = spawn(
    "node",
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(base).port,
    ],
    {
      cwd: appDirectory,
      detached: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let serverLog = ""
  for (const stream of [server.stdout, server.stderr])
    stream!.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-24000)
    })
  const headers = (token = key.key, project = target.projectId) => ({
    authorization: `Bearer ${token}`,
    "x-project-id": project,
    "content-type": "application/json",
  })
  async function agent(
    operation: string,
    input: unknown,
    token = key.key,
    project = target.projectId
  ) {
    return fetch(`${base}/api/agent/${operation}`, {
      method: "POST",
      headers: headers(token, project),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    })
  }
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog)
    try {
      const response = await fetch(
        `${base}/api/agent/describe_agent_operations`,
        {
          method: "POST",
          headers: headers(),
          body: "{}",
          signal: AbortSignal.timeout(1500),
        }
      )
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* Wait for compilation of the actual route. */
    }
    await pause(500)
  }
  assert(ready, serverLog)
  const env = {
    ...process.env,
    DATOOL_BASE_URL: base,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_API_KEY: key.key,
    DATOOL_CONFIG_DIR: join(directory, "cli"),
  }
  async function cli<T>(args: string[], input?: unknown): Promise<T> {
    const inputFile = join(directory, "input.json")
    if (input !== undefined)
      await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 })
    const result = await execute(
      "node",
      [
        join(root, "packages/cli/dist/datool.js"),
        ...args,
        ...(input === undefined ? [] : ["--input", "@" + inputFile]),
        "--no-env",
      ],
      {
        cwd: directory,
        env,
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      }
    )
    return result.stdout.trim() ? JSON.parse(result.stdout) : (null as T)
  }
  const scorer = await cli<{ id: string }>(["scorers", "create"], {
    scorer: {
      ...defaultScorer,
      name: "Count judge",
      slug: "count-judge",
      model: "test",
      messages: [{ role: "user", content: "{{output}}" }],
      threshold: 0.5,
    },
  })
  const dataset = await cli<{ id: string }>(["datasets", "create"], {
    name: "Iteration cases",
  })
  for (const bad of [false, true])
    await cli(["datasets", "add", dataset.id], {
      item: {
        input: { bad, count: bad ? 2 : 1 },
        expectedOutput: { bad: false, count: 1 },

      },
    })
  await cli(["apps", "register"], {
    app: {
      id: "workflow-fixture",
      name: "Fixture app",
      mode: "input",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      connection: {
        type: "webhook",
        url: `http://127.0.0.1:${judge.port}`,
        method: "POST",
        body: "input",
      },
    },
  })
  const started = await cli<EvalRunDetail>(["evals", "run"], {
    name: "Iteration baseline",
    mode: "connected",
    appId: "workflow-fixture",
    datasetId: dataset.id,
    evaluatorIds: [scorer.id],
    requestKey: "e2e-baseline",
  })
  const waitRun = (id: string) =>
    cli<EvalRunDetail>(["evals", "wait", id, "--poll-interval", "0.1"])
  const result = await waitRun(started.id)
  assert.equal(result.status, "completed")
  const page = await cli<EvalRunDetail>(["evals", "get", result.id], {
    limit: 1,
  })
  assert(page.nextCursor)
  const second = await cli<EvalRunDetail>(["evals", "get", result.id], {
    limit: 1,
    cursor: page.nextCursor,
  })
  assert.equal(second.nextCursor, null)
  assert.notEqual(page.rows![0].id, second.rows![0].id)
  const candidate = await waitRun(
    (
      await cli<EvalRunDetail>(["evals", "run"], {
        parentRunId: result.id,
        useRecordedVersions: true,
        inputOverrides: { variant: "candidate" },
        requestKey: "e2e-candidate",
      })
    ).id
  )
  assert.equal(candidate.status, "completed")
  assert.deepEqual(candidate.evaluatorVersionIds, result.evaluatorVersionIds)
  assert.equal(candidate.metadata.parentRunId, result.id)
  assert(
    candidate.rows!.every(
      (row) => (row.trace.input as { variant: string }).variant === "candidate"
    )
  )
  const comparison = await cli<{
    configurationChanges: { kind: string; field: string }[]
  }>(["evals", "compare"], { leftId: result.id, rightId: candidate.id })
  assert(
    comparison.configurationChanges.some(
      (change) =>
        change.kind === "extractor" && change.field === "inputOverrides"
    )
  )
  assert(
    !comparison.configurationChanges.some((change) => change.kind === "judge")
  )
  passed(
    "built CLI runs and iterates with frozen cases and recorded judges; standard run/comparison reads preserve pagination and configuration changes"
  )
  assert.equal(
    (await agent("recover_eval_run", { id: result.id }, reader.key)).status,
    403
  )
  const client = new Client({ name: "eval-iteration-e2e", version: "1" })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), {
      requestInit: { headers: headers() },
    })
  )
  const names = (await client.listTools()).tools.map((tool) => tool.name)
  for (const name of [
    "start_eval_run",
    "recover_eval_run",
    "cancel_eval_run",
    "get_eval_run",
    "compare_eval_runs",
  ])
    assert(names.includes(name))
  assert(!names.includes("save_experiment"))
  const mcpRun = await client.callTool({
    name: "get_eval_run",
    arguments: { id: candidate.id, limit: 1 },
  })
  assert(!mcpRun.isError)
  assert.equal(
    (mcpRun.structuredContent as { data: EvalRunDetail }).data.status,
    "completed"
  )
  const recovered = await cli<EvalRunDetail>(["evals", "recover", candidate.id])
  assert.equal(recovered.status, "completed")
  passed(
    "real MCP discovery and compact run reads; insufficient recovery permissions rejected; completed-run recovery is idempotent"
  )
  const artifact = join(root, "artifacts", "eval-run-iteration")
  await mkdir(artifact, { recursive: true })
  await writeFile(
    join(artifact, "e2e-report.json"),
    JSON.stringify(
      {
        checks,
        baselineId: result.id,
        candidateId: candidate.id,
        configurationChanges: comparison.configurationChanges,
      },
      null,
      2
    )
  )
  console.info(
    JSON.stringify(
      {
        browserLogin: base + "/review-test-login",
        evalUrl:
          base +
          "/p/test-project/evals/" +
          candidate.id +
          "?compare=" +
          result.id,
        directory,
        checks,
      },
      null,
      2
    )
  )
  if (keep)
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
} finally {
  for (const client of clients) await client.close().catch(() => {})
  if (server?.pid && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM")
    await Promise.race([
      new Promise((resolve) => server!.once("exit", resolve)),
      pause(5000),
    ])
    if (server.exitCode === null) process.kill(-server.pid, "SIGKILL")
  }
  if (pools) {
    await pools.analyticsDb.end()
    await pools.db.end()
  }
  judge?.stop()
  await target.close()
  await rm(directory, { recursive: true, force: true })
}

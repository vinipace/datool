import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
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
import { defaultScorer } from "../src/lib/tracer/scorers"
import { readProfile } from "../bin/credentials"

const root = fileURLToPath(new URL("..", import.meta.url))
process.chdir(root)
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-agent-e2e-"))
const appDirectory = join(directory, "app")
const consumer = join(directory, "consumer")
const loginDirectory = join(directory, "login")
const container = `datool-agent-e2e-${randomUUID().slice(0, 8)}`
let ownsContainer = false
let target: Awaited<ReturnType<typeof createIsolatedPostgres>> | undefined
let pools: typeof import("../lib/db") | undefined
let next: ChildProcess | undefined
let mcp: Client | undefined
const received: unknown[] = []
const fixtureApp = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  const { input } = JSON.parse(body)
  received.push(input)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(input))
})
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const checks: string[] = []
const passed = (description: string) => {
  checks.push(description)
  console.info(`PASS ${description}`)
}
const docker = async (...args: string[]) =>
  (await execute("docker", args, { timeout: 60000 })).stdout.trim()

// Use the same executable as the CLI for OS-store access. Switching from Node
// to Bun can require another macOS Keychain approval for the test credential.
// Tokens stay inside this Node process; only assertions/hashes cross to Bun.
async function fixtureCredential(action: string, id = "") {
  const script = `
    import { Entry } from '@napi-rs/keyring';
    import { readFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const [directory, action, id] = process.argv.slice(1);
    let profile;
    try { profile = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!profile && !id) { console.log('{}'); process.exit(0); }
    const entry = new Entry('datool-cli', profile?.id ?? id);
    if (action === 'cleanup') { console.log(JSON.stringify({ removed: entry.deleteCredential() })); process.exit(0); }
    const raw = entry.getPassword();
    if (action === 'absent') { console.log(JSON.stringify({ absent: raw === null })); process.exit(0); }
    const secret = JSON.parse(raw);
    if (action === 'expire') entry.setPassword(JSON.stringify({ ...secret, expiresAt: 0 }));
    const output = { refreshHash: createHash('sha256').update(secret.refreshToken).digest('hex'),
      privateOnDisk: JSON.stringify(profile).includes(secret.accessToken) || JSON.stringify(profile).includes(secret.refreshToken) };
    if (action === 'audience') {
      const response = await fetch(profile.origin + '/api/mcp', { method: 'POST', headers: {
        authorization: 'Bearer ' + secret.accessToken, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
      output.status = response.status;
    }
    console.log(JSON.stringify(output));
  `
  const result = await execute("node", ["--input-type=module", "--eval", script, loginDirectory, action, id], { cwd: root, timeout: 30_000 })
  return JSON.parse(result.stdout)
}

async function availablePort() {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const port = (socket.address() as import("node:net").AddressInfo).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
  // Next may launch a worker process. The isolated process group belongs to this test.
  try {
    process.kill(-child.pid!, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    pause(5000),
  ])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
}

try {
  await docker(
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=agent-e2e-fixture",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine"
  )
  ownsContainer = true
  let databaseReady = false
  for (let i = 0; i < 40; i++) {
    try {
      // The image briefly exposes a socket-only server during initialization.
      // Wait for TCP so the migration cannot race that server's shutdown.
      await docker(
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres"
      )
      databaseReady = true
      break
    } catch {
      await pause(250)
    }
  }
  assert(databaseReady, "Disposable PostgreSQL did not become ready")
  const pgPort = (await docker("port", container, "5432/tcp")).split(":").at(-1)
  process.env.DATOOL_TEST_DATABASE_URL = `postgresql://postgres:agent-e2e-fixture@127.0.0.1:${pgPort}/postgres`
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const base = `http://127.0.0.1:${await availablePort()}`
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "disposable-agent-end-to-end-secret-123456789",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: "development",
  })
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const credential = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Agent E2E",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10000,
      rateLimitTimeWindow: 60000,
    },
  })
  const reader = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Agent E2E reader",
      permissions: permissionStatements([
        "datasets:read",
        "evals:read",
        "traces:read",
      ]),
      rateLimitMax: 10000,
    },
  })
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(target.ownerId)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`

  // Run actual Next routes in a copy: no .env files, active dev output or user data.
  await mkdir(appDirectory)
  for (const path of [
    "app",
    "components",
    "lib",
    "src",
    "package.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
    "postcss.config.mjs",
  ]) {
    await cp(join(root, path), join(appDirectory, path), { recursive: true })
  }
  await symlink(
    join(root, "node_modules"),
    join(appDirectory, "node_modules"),
    "dir"
  )
  next = spawn(
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
  for (const stream of [next.stdout, next.stderr])
    stream!.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-24000)
    })
  let ready = false
  for (let i = 0; i < 90; i++) {
    if (next.exitCode !== null) throw new Error(`Next exited: ${serverLog}`)
    try {
      const response = await fetch(
        `${base}/api/agent/describe_agent_operations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential.key}`,
            "x-project-id": target.projectId,
          },
          body: "{}",
          signal: AbortSignal.timeout(1500),
        }
      )
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* Allow the isolated server to compile its route. */
    }
    await pause(500)
  }
  if (!ready) throw new Error(`Next did not become ready: ${serverLog}`)
  passed("actual Next.js server with isolated PostgreSQL and organization keys")

  await mkdir(consumer)
  await writeFile(
    join(consumer, "package.json"),
    '{"private":true,"type":"module"}'
  )
  const manifest = JSON.parse(
    await readFile(join(root, "packages/cli/package.json"), "utf8")
  )
  await execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      process.env.DATOOL_CLI_TEST_VERSION
        ? `@datool/cli@${process.env.DATOOL_CLI_TEST_VERSION}`
        : join(root, "artifacts/npm", `datool-cli-${manifest.version}.tgz`),
    ],
    { cwd: consumer, timeout: 60000 }
  )
  const cliPath = join(consumer, "node_modules/@datool/cli/dist/datool.js")
  const env = {
    ...process.env,
    DATOOL_BASE_URL: base,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_API_KEY: credential.key,
    DATOOL_CONFIG_DIR: loginDirectory,
  }
  async function command(
    args: string[],
    input?: unknown,
    expectedExit = 0,
    overrides: Partial<NodeJS.ProcessEnv> = {}
  ) {
    const file = join(consumer, `${randomUUID()}.json`)
    if (input !== undefined) await writeFile(file, JSON.stringify(input))
    const parameters = [
      cliPath,
      ...args,
      ...(input === undefined ? [] : ["--input", `@${file}`]),
    ]
    let result: { stdout: string; stderr: string; code?: number } = {
      stdout: "",
      stderr: "",
      code: 0,
    }
    try {
      result = {
        ...(await execute("node", parameters, {
          cwd: consumer,
          env: { ...env, ...overrides },
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024,
        })),
        code: 0,
      }
    } catch (error) {
      const e = error as Error & typeof result
      result = { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code }
    }
    assert.equal(
      result.code,
      expectedExit,
      `${args.join(" ")}: ${result.stderr}`
    )
    return result
  }
  async function cli(args: string[], input?: unknown, expectedExit = 0) {
    const result = await command(args, input, expectedExit)
    return JSON.parse(result.stdout)
  }
  async function api(path: string, input?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.key}`,
        "x-project-id": target!.projectId,
        "content-type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(60000),
    })
    assert(response.ok, `${path}: HTTP ${response.status}`)
    return (await response.json()).data
  }
  const schemas = await cli(["agent", "tools", "start_eval_run"])
  assert.equal((await command(["--version"])).stdout.trim(), process.env.DATOOL_CLI_TEST_VERSION ?? manifest.version)
  assert(schemas[0].inputSchema.properties.requestKey)
  const traceSession = await api("/api/sessions", { name: "Foundation E2E" })
  const trace = await api("/api/traces", {
    name: "Foundation evidence",
    sessionId: traceSession.id,
    input: { value: 1 },
    output: { value: 1 },
    status: "completed",
    spans: [
      { name: "Real internal evidence", kind: "custom", status: "completed" },
    ],
  })
  assert.equal(
    (
      await cli([
        "traces",
        "list",
        "--filter",
        'name = "Foundation evidence"',
        "--limit",
        "1",
      ])
    ).items[0].id,
    trace.id
  )
  assert.equal(
    (await cli(["traces", "spans", trace.id])).items[0].name,
    "Real internal evidence"
  )
  assert.equal(
    (await cli(["sessions", "get", traceSession.id])).traces[0].id,
    trace.id
  )
  passed(
    "packed CLI trace filters, real spans and session investigation over HTTP"
  )

  const dataset = await cli(["datasets", "create"], { name: "e2e/regression" })
  const bulk = await cli(["datasets", "bulk", dataset.id], {
    create: [
      {
        id: "case-a",
        input: { value: 1 },
        expectedOutput: { value: 1 },
        sourceTraceId: trace.id,
      },
      {
        id: "case-b",
        input: { value: 2 },
        expectedOutput: { value: 99 },
        sourceTraceId: trace.id,
      },
    ],
  })
  assert.equal(bulk.created.length, 2)
  const snapshot = await cli([
    "datasets",
    "snapshot",
    dataset.id,
    "--label",
    "baseline",
  ])
  await cli(["datasets", "bulk", dataset.id], {
    expectedHash: snapshot.contentHash,
    update: [{ id: "case-a", patch: { expectedOutput: { value: 500 } } }],
    delete: ["case-b"],
  })
  assert.equal(
    (
      await cli([
        "datasets",
        "version",
        dataset.id,
        "--version-id",
        snapshot.id,
      ])
    ).items.length,
    2
  )
  await command(["datasets", "create"], { name: "denied" }, 1, {
    DATOOL_API_KEY: reader.key,
  })
  await command(["datasets", "get", dataset.id], undefined, 1, {
    DATOOL_PROJECT_ID: randomUUID(),
  })
  passed(
    "atomic edits, immutable snapshot after edits/deletion, permission and project rejection"
  )

  const configuration = {
    ...defaultScorer,
    name: "E2E exact",
    slug: "e2e-exact",
    type: "javascript",
    threshold: 0.5,
    code: "function evaluate({trace,datasetItem}) { return {score: trace.output.value === datasetItem.expectedOutput.value ? 1 : 0}; }",
  }
  const scorer = await cli(["scorers", "create"], { scorer: configuration })
  const version = (await cli(["scorers", "versions", scorer.id])).items[0]
  const preview = await cli(["scorers", "test"], {
    traceId: trace.id,
    scorerId: scorer.id,
    versionId: version.id,
    datasetId: dataset.id,
    datasetItemId: "case-a",
    datasetVersionId: snapshot.id,
  })
  assert.equal(preview.result.score, 1)
  assert.equal(preview.persisted, false)
  passed("saved scorer versions and nonpersisting real-trace scorer preview")

  await new Promise<void>((resolve) =>
    fixtureApp.listen(0, "127.0.0.1", resolve)
  )
  const appUrl = `http://127.0.0.1:${(fixtureApp.address() as import("node:net").AddressInfo).port}/call`
  await api("/api/apps") // Compile the route before the CLI's normal request deadline.
  await command(["connect", appUrl, "--name", "Foundation echo"])
  const app = (await api("/api/apps")).find(
    (row: { url: string }) => row.url === appUrl
  )
  assert(app)
  const runInput = {
    requestKey: "e2e-baseline",
    mode: "connected",
    appId: app.id,
    datasetId: dataset.id,
    datasetVersionId: snapshot.id,
    evaluatorIds: [scorer.id],
    evaluatorVersionIds: { [scorer.id]: version.id },
  }
  const baseline = await cli(
    ["evals", "run", "--wait", "--timeout", "30"],
    runInput
  )
  assert.equal(baseline.status, "completed")
  assert.equal(baseline.resultCount, 2)
  assert.equal(received.length, 2)
  assert.equal((await cli(["evals", "run"], runInput)).id, baseline.id)
  assert.equal(received.length, 2)
  const failedGate = await cli(["evals", "gate", baseline.id], undefined, 2)
  assert.equal(failedGate.passed, false)
  assert.equal(failedGate.run.actual, 2)
  assert.equal(failedGate.run.score, 0.5)
  passed(
    "connected snapshot execution, wait, retry without duplicate app calls and CI exit 2"
  )

  await cli(["scorers", "update", scorer.id, "--expected-revision", "1"], {
    scorer: {
      ...configuration,
      code: "function evaluate() { return {score: 1}; }",
    },
  })
  await command(
    ["scorers", "update", scorer.id, "--expected-revision", "1"],
    { scorer: configuration },
    1
  )
  const candidate = await cli(["evals", "rescore", baseline.id, "--wait"], {
    requestKey: "e2e-candidate",
    evaluatorIds: [scorer.id],
  })
  assert.equal(received.length, 2)
  const gate = await cli([
    "evals",
    "gate",
    candidate.id,
    "--min-score",
    "1",
    "--baseline-id",
    baseline.id,
  ])
  assert.equal(gate.passed, true)
  assert.equal(
    (
      await cli([
        "evals",
        "compare",
        "--left-id",
        baseline.id,
        "--right-id",
        candidate.id,
      ])
    ).pairs.length,
    2
  )
  passed(
    "revision conflicts, re-score without app execution, case comparison and passing regression gate"
  )

  const query = {
    measures: ["traces.count"],
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: [
          new Date(Date.now() - 86400000).toISOString(),
          new Date(Date.now() + 1000).toISOString(),
        ],
      },
    ],
  }
  const metadata = await cli(["metrics", "metadata"])
  assert(
    metadata.models.some((model: { name: string }) => model.name === "traces")
  )
  assert(
    (await cli(["metrics", "query"], { query })).data[0]["traces.count"] >= 3
  )
  const dashboard = await cli(["dashboards", "create"], {
    config: {
      schemaVersion: 1,
      name: "Foundation preview",
      description: "",
      widgets: [
        { id: "count", title: "Traces", type: "metric", width: 1, query },
      ],
    },
  })
  assert(
    (await cli(["dashboards", "preview", dashboard.id])).results[0].data[0][
      "traces.count"
    ] >= 3
  )
  const link = await cli(["datasets", "resolve", "e2e/regression"])
  assert.equal(new URL(link.url).origin, base)
  assert(link.url.endsWith(`/datasets/${dataset.id}`))
  const out = join(consumer, "results.ndjson")
  const exported = await command([
    "evals",
    "export",
    candidate.id,
    "--out",
    out,
  ])
  assert.equal(JSON.parse(exported.stderr).complete, true)
  assert.equal((await readFile(out, "utf8")).trim().split("\n").length, 2)
  passed(
    "semantic queries, dashboard preview, canonical links and complete NDJSON export"
  )

  // Consent and token issuance use the same HTTP flow as the MCP connection UI.
  const browserHeaders = {
    cookie,
    origin: base,
    "content-type": "application/json",
  }
  async function authPost(path: string, body: unknown, anonymous = false) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...browserHeaders, ...(anonymous ? { cookie: "" } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    assert(response.ok, `${path}: HTTP ${response.status}`)
    return response.json()
  }
  const scope = "traces:read evals:read datasets:read"
  const registration = await authPost(
    "/api/auth/oauth2/register",
    {
      application_type: "native",
      client_name: "Foundation E2E",
      redirect_uris: ["http://127.0.0.1:39991/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope,
    },
    true
  )
  const verifier = randomUUID() + randomUUID()
  const params = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: "http://127.0.0.1:39991/callback",
    response_type: "code",
    scope,
    resource: `${base}/api/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e-state",
  })
  const authorization = await fetch(
    `${base}/api/auth/oauth2/authorize?${params}`,
    {
      headers: browserHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    }
  )
  const destination =
    authorization.headers.get("location") ?? (await authorization.json()).url
  assert(destination.includes("/mcp/connect"))
  const continued = (
    await authPost("/api/mcp/authorization", {
      action: "continue",
      projectId: target.projectId,
      oauth_query: new URL(destination, base).search.slice(1),
    })
  ).data
  const granted = (
    await authPost("/api/mcp/authorization", {
      action: "consent",
      projectId: target.projectId,
      accept: true,
      oauth_query: new URL(continued.url, base).search.slice(1),
    })
  ).data
  const callback = new URL(granted.url)
  assert.equal(callback.searchParams.get("state"), "e2e-state")
  const tokenResponse = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: callback.searchParams.get("code")!,
      redirect_uri: "http://127.0.0.1:39991/callback",
      code_verifier: verifier,
      resource: `${base}/api/mcp`,
    }),
    signal: AbortSignal.timeout(60000),
  })
  assert(tokenResponse.ok)
  const token = await tokenResponse.json()
  mcp = new Client({ name: "Foundation E2E", version: "1" })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${token.access_token}` },
      },
    })
  )
  const tools = await mcp.listTools()
  assert(tools.tools.some((tool) => tool.name === "get_trace"))
  assert(!tools.tools.some((tool) => tool.name === "start_eval_run"))
  const mcpTrace = await mcp.callTool({
    name: "get_trace",
    arguments: { id: trace.id },
  })
  assert.equal(
    (mcpTrace.structuredContent as { data: { id: string } }).data.id,
    trace.id
  )
  const mcpGate = await mcp.callTool({
    name: "gate_eval_run",
    arguments: { id: candidate.id, minScore: 1 },
  })
  assert.equal(
    (mcpGate.structuredContent as { data: { passed: boolean } }).data.passed,
    true
  )
  passed(
    "real OAuth project selection, consent and PKCE token exchange; MCP HTTP trace and gate reads"
  )
  // Execute the installed CLI's browser callback and real OS credential store.
  await api("/api/cli/info")
  await api("/api/cli/session")
  const interactiveEnv = { ...env, DATOOL_API_KEY: "", DATOOL_PROJECT_ID: "", DATOOL_BASE_URL: "" }
  const loginChild = spawn("node", [cliPath, "auth", "login", "--datool", base, "--no-browser"], {
    cwd: consumer, env: interactiveEnv, stdio: ["ignore", "pipe", "pipe"],
  })
  let loginOutput = ""
  let loginError = ""
  loginChild.stdout.on("data", data => { loginOutput += data })
  loginChild.stderr.on("data", data => { loginError += data })
  const loginDone = new Promise<number | null>(resolve => loginChild.once("exit", resolve))
  try {
    let authorizeUrl: string | undefined
    for (let attempt = 0; attempt < 120 && loginChild.exitCode === null; attempt++) {
      authorizeUrl = /Open this URL on this computer: (\S+)/.exec(loginError)?.[1]
      if (authorizeUrl) break
      await pause(250)
    }
    assert(authorizeUrl, `CLI did not start browser authorization: ${loginError}`)
    const start = await fetch(authorizeUrl, { headers: browserHeaders, redirect: "manual" })
    const destination = start.headers.get("location") ?? (await start.json()).url
    assert(destination.includes("/mcp/connect"))
    const selection = (await authPost("/api/mcp/authorization", {
      action: "continue", projectId: target.projectId, oauth_query: new URL(destination, base).search.slice(1),
    })).data
    const approval = (await authPost("/api/mcp/authorization", {
      action: "consent", projectId: target.projectId, accept: true, oauth_query: new URL(selection.url, base).search.slice(1),
    })).data
    // A stray callback must not consume the real authorization.
    const badState = new URL(approval.url); badState.searchParams.set("state", "wrong-state")
    assert.equal((await fetch(badState)).status, 400)
    assert.equal((await fetch(approval.url)).status, 200)
    assert.equal(await loginDone, 0, `CLI login failed: ${loginError}`)
    assert(loginOutput.includes("Credentials saved in the OS credential store"))
  } finally { if (loginChild.exitCode === null) loginChild.kill("SIGTERM") }
  const profile = await readProfile(loginDirectory)
  assert(profile)
  assert.equal(profile.projectId, target.projectId)
  const stored = await fixtureCredential("inspect")
  assert.equal(stored.privateOnDisk, false)
  const doctor = JSON.parse((await command(["doctor", "--json"], undefined, 0, interactiveEnv)).stdout)
  assert.equal(doctor.ok, true)
  assert.equal(doctor.authentication, "saved-oauth")
  assert.equal(doctor.configuration.sources.host, "saved login")
  await command(["traces", "list", "--limit", "1"], undefined, 0, interactiveEnv)
  await command(["traces", "list", "--project", "wrong-project"], undefined, 1, interactiveEnv)
  // Force expiry in this fixture credential to exercise refresh from a fresh CLI process.
  await fixtureCredential("expire")
  await command(["traces", "list", "--limit", "1"], undefined, 0, interactiveEnv)
  const refreshed = await fixtureCredential("inspect")
  assert.notEqual(refreshed.refreshHash, stored.refreshHash)
  // Resource audience is enforced in both directions.
  const mismatched = await fetch(`${base}/api/agent/list_traces`, {
    method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "x-project-id": target.projectId, "content-type": "application/json" }, body: "{}",
  })
  assert.equal(mismatched.status, 401)
  assert.equal((await fixtureCredential("audience")).status, 401)
  await command(["auth", "logout"], undefined, 0, interactiveEnv)
  assert.equal(await readProfile(loginDirectory), null)
  assert.equal((await fixtureCredential("absent", profile.id)).absent, true)
  passed("installed CLI OAuth login, project selection, state validation, OS keychain, doctor, trace read, refresh rotation, audience isolation and logout")
  console.info(`PASS all ${checks.length} end-to-end checkpoints`)
} finally {
  let retainLoginMetadata = false
  try { await fixtureCredential("cleanup") }
  catch {
    retainLoginMetadata = true
    process.exitCode = 1
    console.error(`Could not remove the temporary OS credential. Its non-secret profile is retained in ${loginDirectory}.`)
  }
  await mcp?.close().catch(() => {})
  fixtureApp.closeAllConnections()
  if (fixtureApp.listening)
    await new Promise<void>((resolve) => fixtureApp.close(() => resolve()))
  if (next) await stop(next)
  if (pools) await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  await target?.close()
  if (ownsContainer) await docker("rm", "-f", container).catch(() => {})
  if (retainLoginMetadata) await Promise.all([rm(appDirectory, { recursive: true, force: true }), rm(consumer, { recursive: true, force: true })])
  else await rm(directory, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer, request as httpRequest } from "node:http"
import { createServer as createHttpsServer } from "node:https"
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
import { makeSignature } from "better-auth/crypto"
import { pdfFixture } from "../tests/helpers/build-documents"
import { runBuildOperationsE2e } from "./build-e2e-operations"
import { runBuildAuthoringE2e } from "./build-e2e-authoring"
import { runBuildUiE2e, selectAgentSection } from "./build-e2e-ui"
import { runBuildDashboardE2e } from "./build-e2e-dashboards"
import { chromium, type Browser, type Page } from "playwright"
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

// Exercise actual Next HTTP, browser, MCP, and background-worker boundaries.
// Only the explicitly selected disposable loopback PostgreSQL may be changed.
const root = process.cwd()
const productionServer = process.argv.includes("--production")
const productionCompile =
  productionServer || process.argv.includes("--production-compile")
const liveModelKey = process.argv.includes("--live-model")
  ? process.env.OPENAI_API_KEY
  : undefined
if (process.argv.includes("--live-model"))
  assert(
    liveModelKey,
    "--live-model requires OPENAI_API_KEY in the local environment."
  )
const directory = await mkdtemp(join(tmpdir(), "datool-build-e2e-"))
const appDirectory = join(directory, "app")
const evidence = join(root, "artifacts/build-e2e")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let target: Awaited<ReturnType<typeof createIsolatedPostgres>> | undefined
let pools: typeof import("../lib/db") | undefined
let browser: Browser | undefined
let activePage: Page | undefined
let mcp: Client | undefined
let customerSite: ReturnType<typeof createServer> | undefined
let tlsProxy: ReturnType<typeof createHttpsServer> | undefined
let tlsOrigin: string | undefined
let tlsCa: string | undefined
// Trust only this fixture's certificate when calling its exact loopback origin.
// Internet requests retain normal certificate verification.
function fetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
) {
  const url = input instanceof Request ? input.url : String(input)
  const options: RequestInit & { tls?: { ca: string } } = {
    ...init,
    ...(tlsCa && new URL(url).origin === tlsOrigin
      ? { tls: { ca: tlsCa } }
      : {}),
  }
  return globalThis.fetch(input, options)
}
const children: ChildProcess[] = []
const logs: string[] = []
const checkpoints: string[] = []
function passed(value: string) {
  checkpoints.push(value)
  console.info(`PASS ${value}`)
}
async function port() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const value = (server.address() as import("node:net").AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return value
}
function start(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd: appDirectory,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  for (const stream of [child.stdout, child.stderr])
    stream!.on("data", (value) => {
      const text = String(value)
      logs.push(
        liveModelKey ? text.replaceAll(liveModelKey, "[redacted]") : text
      )
      if (logs.length > 2000) logs.shift()
    })
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
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
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const appPort = await port()
  const base = `${productionServer ? "https" : "http"}://127.0.0.1:${productionServer ? await port() : appPort}`
  if (productionServer) {
    const keyPath = join(directory, "loopback.key")
    const certPath = join(directory, "loopback.crt")
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" }
    )
    tlsCa = await readFile(certPath, "utf8")
    tlsOrigin = base
    tlsProxy = createHttpsServer(
      { key: await readFile(keyPath), cert: tlsCa },
      (request, response) => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: appPort,
            method: request.method,
            path: request.url,
            headers: {
              ...request.headers,
              host: new URL(base).host,
              "x-forwarded-host": new URL(base).host,
              "x-forwarded-proto": "https",
            },
          },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers)
            result.pipe(response)
          }
        )
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        })
        request.on("aborted", () => upstream.destroy())
        response.on("close", () => {
          if (!response.writableEnded) upstream.destroy()
        })
        request.pipe(upstream)
      }
    )
    await new Promise<void>((resolve) =>
      tlsProxy!.listen(Number(new URL(base).port), "127.0.0.1", resolve)
    )
  }
  // Do not inherit provider credentials or remote services from a local .env.
  for (const name of Object.keys(process.env)) {
    if (
      /^(REDIS_|UPSTASH_|GOOGLE_|OPENAI_|AI_GATEWAY_|ANTHROPIC_|STRIPE_|PAYLOAD_|DATOOL_PROVIDER_)/.test(
        name
      )
    )
      delete process.env[name]
  }
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: base,
    DATOOL_PUBLIC_URL: base,
    BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    DATOOL_BILLING_ENABLED: "false",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: productionServer ? "production" : "development",
    NEXT_TELEMETRY_DISABLED: "1",
  })
  pools = await import("../lib/db")
  if (liveModelKey) {
    const { saveProjectProviderKey } =
      await import("../src/server/model-providers/store")
    await saveProjectProviderKey(target.projectId, "openai", liveModelKey)
  }
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const key = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Build E2E",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10000,
    },
  })
  const reader = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Build E2E reader",
      permissions: permissionStatements(["build:read"]),
      rateLimitMax: 10000,
    },
  })
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(target.ownerId)
  assert(session)
  await pools.db.query(
    'UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2',
    [target.organizationId, session.id]
  )
  const signature = await makeSignature(session.token, context.secret)
  const cookieValue = encodeURIComponent(`${session.token}.${signature}`)
  await mkdir(appDirectory)
  await mkdir(evidence, { recursive: true })
  await rm(join(evidence, "report.json"), { force: true })
  for (const path of [
    "app",
    "components",
    "lib",
    "src",
    "public",
    "scripts",
    "bin",
    "examples",
    "packages",
    "tests",
    ".storybook",
    "content",
    "cms",
    "assets",
    ".source",
    "payload-migrations",
    "package.json",
    "bun.lock",
    "LICENSE",
    "LICENSING.md",
    "LICENSES",
    "tsconfig.json",
    "next-env.d.ts",
    "bun-test.d.ts",
    "next.config.ts",
    "postcss.config.mjs",
    "vitest.config.mts",
    "drizzle.config.ts",
    "source.config.ts",
    "payload.config.ts",
    "payload-types.ts",
    "proxy.ts",
  ]) {
    await cp(join(root, path), join(appDirectory, path), {
      recursive: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  await symlink(
    join(root, "node_modules"),
    join(appDirectory, "node_modules"),
    "dir"
  )
  const env = { ...process.env }
  if (productionCompile) {
    console.info("Compiling the isolated production application…")
    const build = start(
      "node",
      [join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"],
      {
        ...env,
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=4096",
      }
    )
    const code = await new Promise<number | null>((resolve, reject) => {
      build.once("error", reject)
      build.once("exit", resolve)
    })
    await writeFile(join(evidence, "production-build.log"), logs.join(""))
    assert.equal(code, 0, "The isolated production build failed.")
    passed("Next production compilation against the isolated database")
    if (!productionServer)
      await rm(join(appDirectory, ".next"), { recursive: true, force: true })
  }
  const next = start(
    "node",
    [
      join(root, "node_modules/next/dist/bin/next"),
      ...(productionServer ? ["start"] : ["dev", "--webpack"]),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    env
  )
  async function call(
    name: string,
    input: Record<string, unknown> = {},
    token = key.key,
    expected = 200
  ) {
    const response = await fetch(`${base}/api/build/${name}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-project-id": target!.projectId,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(90_000),
    })
    const body = await response.json()
    assert.equal(response.status, expected, `${name}: ${JSON.stringify(body)}`)
    return expected >= 400 ? body.error : body.data
  }
  let ready = false
  for (let i = 0; i < 90; i++) {
    if (next.exitCode !== null)
      throw new Error("The isolated Next process exited.")
    try {
      const response = await fetch(
        `${base}/api/build/build_describe_operations`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.key}`,
            "x-project-id": target.projectId,
            "content-type": "application/json",
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
      /* Route compilation can exceed the readiness request deadline. */
    }
    await pause(500)
  }
  assert(ready, "The isolated Next server did not become ready.")
  const catalog = (await call("build_describe_operations")) as {
    name: string
  }[]
  assert(catalog.some((item) => item.name === "build_create_agent"))
  const readerCatalog = (await call(
    "build_describe_operations",
    {},
    reader.key
  )) as { name: string }[]
  assert(!readerCatalog.some((item) => item.name === "build_create_agent"))
  await call("build_create_agent", { name: "Denied" }, reader.key, 403)
  passed("HTTP operation discovery and read-only scope enforcement")

  // This is the disposable schema only. Exercise an upgrade failure through
  // HTTP so missing tables cannot degrade into an opaque internal error.
  await pools.db.query(
    "ALTER TABLE build_agents RENAME TO build_agents_unready_e2e"
  )
  try {
    const unavailable = await call("build_list_agents", {}, key.key, 503)
    assert.equal(unavailable.details.reason, "BUILD_SCHEMA_NOT_READY")
    assert.match(unavailable.message, /database upgrade/i)
  } finally {
    await pools.db.query(
      "ALTER TABLE build_agents_unready_e2e RENAME TO build_agents"
    )
  }
  passed(
    "an unmigrated Build schema returns an actionable 503 without database details"
  )

  browser = await chromium.launch({ headless: true })
  const browserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    // Only this disposable browser context accepts the generated loopback cert.
    ignoreHTTPSErrors: productionServer,
  })
  // Cold Next development compilation can outlast Playwright's 30-second
  // navigation default. Element/action deadlines remain unchanged.
  browserContext.setDefaultNavigationTimeout(120_000)
  await browserContext.addCookies([
    {
      name: context.authCookies.sessionToken.name,
      value: cookieValue,
      url: base,
      secure: productionServer,
    },
  ])
  const page = await browserContext.newPage()
  activePage = page
  const errors: string[] = []
  let injectingListFailure = true
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => {
    if (response.headers()["x-build-e2e-fault"] === "expected") return
    if (
      injectingListFailure &&
      response.url().endsWith("/api/build/build_list_agents")
    )
      return
    if (response.url().includes("/api/build/") && response.status() >= 400)
      errors.push(
        `${new URL(response.url()).pathname}: HTTP ${response.status()}`
      )
  })
  const prefix = `${base}/p/test-project/build`
  // Check the template with no customer activity before running the live flows.
  // An older configuration must not block the catalog or new dashboard creation.
  await pools.db.query(
    "INSERT INTO dashboards (id, project_id, name, config_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
    [
      "unsupported-dashboard",
      target.projectId,
      "Older dashboard",
      JSON.stringify({
        schemaVersion: 1,
        name: "Older dashboard",
        description: "",
        widgets: [{ type: "matrix" }],
      }),
      new Date().toISOString(),
    ]
  )
  await runBuildDashboardE2e({
    page,
    prefix,
    messageCount: 0,
    handoffCount: 0,
    evidence,
    passed,
  })
  let failedListReads = 0
  await page.route("**/api/build/build_list_agents", async (route) => {
    failedListReads++
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Build requires a database upgrade before it can be used.",
        },
      }),
    })
  })
  await page.goto(`${prefix}/agents`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
  await pause(1500)
  assert.equal(
    failedListReads,
    1,
    "A failed list read must not trigger a render/request loop."
  )
  await page.screenshot({
    path: join(evidence, "agents-error.png"),
    fullPage: true,
  })
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await pause(1000)
  assert.equal(failedListReads, 2, "Explicit Retry must issue one new request.")
  await page.unroute("**/api/build/build_list_agents")
  injectingListFailure = false
  passed(
    "browser errors settle without a request flood and explicit Retry issues one read"
  )
  await page.goto(`${prefix}/agents`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  await page.getByText("Build your first agent", { exact: true }).waitFor()
  await page.screenshot({
    path: join(evidence, "agents-empty.png"),
    fullPage: true,
  })
  await page
    .getByRole("link", { name: "New agent", exact: true })
    .first()
    .click()
  await page.waitForURL(/\/build\/agents\/new$/, { timeout: 120_000 })
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Build validation agent")
  await page
    .getByRole("textbox", { name: "Slug", exact: true })
    .fill("build-validation")
  await page.getByRole("button", { name: "Create agent", exact: true }).click()
  await page.waitForURL(/\/build\/agents\/(?!new)[^/?]+/, { timeout: 30_000 })
  const agentId = new URL(page.url()).pathname.split("/").at(-1)!
  await selectAgentSection(page, "Settings")
  await page.getByRole("textbox", { name: "Name", exact: true }).waitFor()
  await page.screenshot({
    path: join(evidence, "agent-settings.png"),
    fullPage: true,
  })
  const agent = await call("build_get_agent", { agentId })
  assert.equal(agent.name, "Build validation agent")
  passed(
    "authenticated browser empty state and agent creation through shared form"
  )

  await selectAgentSection(page, "Knowledge")
  await page.getByRole("button", { name: "Add source", exact: true }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Returns")
  await page
    .getByRole("textbox", { name: "Source content", exact: true })
    .fill(
      "Products can be returned within thirty days with the receipt. The unique returns authorization phrase is violet harbor."
    )
  await page.getByRole("button", { name: "Add source", exact: true }).click()
  await page
    .getByRole("status")
    .filter({ hasText: "Knowledge source added" })
    .waitFor()
  passed("browser authors a knowledge source and queues indexing")
  const pdfSource = await call("build_create_knowledge_source", {
    source: {
      agentId,
      name: "PDF policy",
      kind: "file",
      fileName: "policy.pdf",
      contentBase64: Buffer.from(pdfFixture()).toString("base64"),
    },
  })
  assert(pdfSource.id)
  passed(
    "PDF upload extracts text through the bundled Next route and isolated parser"
  )
  const worker = start(
    process.execPath,
    ["run", "scripts/build-worker.ts"],
    env
  )
  let indexed = false
  for (let i = 0; i < 45; i++) {
    if (worker.exitCode !== null) throw new Error("The Build worker exited.")
    const sources = await call("build_list_knowledge_sources", { agentId })
    const items = Array.isArray(sources) ? sources : sources.items
    if (
      items.length === 2 &&
      items.every((item: { status: string }) => item.status === "ready")
    ) {
      indexed = true
      break
    }
    await pause(1000)
  }
  assert(indexed, "The Build worker did not index the queued source.")
  passed(
    "background worker consumes and publishes a real knowledge indexing job"
  )

  // The public echo service receives disposable fixture data only. This is a
  // real TLS/DNS-pinned integration call, not a replacement action executor.
  const integration = await call("build_save_action", {
    agentId,
    id: "echo-order",
    definition: {
      id: "echo-order",
      name: "Validate order integration",
      description:
        "Send a synthetic order to the public integration echo service.",
      type: "http",
      method: "POST",
      url: "https://postman-echo.com/post",
      headers: { "X-Workspace": "disposable-e2e-header" },
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      responseSchema: {
        type: "object",
        properties: {
          json: {
            type: "object",
            properties: { orderId: { const: "synthetic-order-42" } },
            required: ["orderId"],
          },
        },
        required: ["json"],
      },
      procedureOnly: true,
    },
  })
  assert.equal(integration.definition.headers["X-Workspace"], "[redacted]")
  await call("build_save_procedure", {
    agentId,
    definition: {
      name: "Validate the order system",
      trigger: { type: "keyword", value: "validate-order-integration" },
      actionRefs: [integration.id],
      steps: [
        {
          id: "echo",
          kind: "action",
          actionId: integration.id,
          input: { orderId: "synthetic-order-42" },
        },
      ],
    },
  })
  const formAction = await call("build_save_action", {
    agentId,
    definition: {
      id: "order-form",
      name: "Order form",
      type: "form",
      procedureOnly: true,
      fields: [
        { name: "orderId", label: "Order ID", type: "text", required: true },
      ],
      submitActionId: integration.id,
    },
  })
  await call("build_save_procedure", {
    agentId,
    definition: {
      name: "Collect an order",
      trigger: { type: "keyword", value: "show-order-form" },
      actionRefs: [formAction.id, integration.id],
      steps: [{ id: "form", kind: "action", actionId: formAction.id }],
    },
  })
  await call("build_save_procedure", {
    agentId,
    definition: {
      name: "Resume a customer wait automatically",
      trigger: { type: "keyword", value: "validate-automatic-wait" },
      steps: [
        { id: "before", kind: "message", content: "The wait has started." },
        { id: "wait", kind: "wait", seconds: 1 },
        {
          id: "after",
          kind: "message",
          content: "The automatic wait has finished.",
        },
      ],
    },
  })
  const handoff = await call("build_save_action", {
    agentId,
    definition: {
      id: "handoff-support",
      name: "Connect a teammate",
      type: "handoff",
      message: "A teammate will continue this conversation.",
      procedureOnly: true,
    },
  })
  await call("build_save_procedure", {
    agentId,
    definition: {
      name: "Customer requests a teammate",
      trigger: { type: "keyword", value: "validate-agent-handoff" },
      actionRefs: [handoff.id],
      steps: [{ id: "handoff", kind: "handoff", actionId: handoff.id }],
    },
  })
  const orderWidget = await call("build_save_widget", {
    agentId,
    definition: {
      name: "Customer order widget",
      components: [
        { type: "text", text: "Check an order from this widget." },
        { type: "form", fields: ["orderId"], submitActionId: integration.id },
      ],
    },
  })
  const widgetAction = await call("build_save_action", {
    agentId,
    definition: {
      id: "open-order-widget",
      name: "Open customer order widget",
      type: "widget",
      widgetId: orderWidget.id,
      eventName: "customer.order",
      procedureOnly: true,
    },
  })
  await call("build_save_procedure", {
    agentId,
    definition: {
      name: "Show customer order widget",
      trigger: { type: "keyword", value: "validate-order-widget" },
      actionRefs: [widgetAction.id, integration.id],
      steps: [{ id: "widget", kind: "action", actionId: widgetAction.id }],
    },
  })

  await selectAgentSection(page, "Instructions")
  await page
    .getByRole("textbox", { name: "System instructions", exact: true })
    .press("ControlOrMeta+A")
  await page.keyboard.insertText(
    "Answer customer questions using the supplied knowledge. Keep answers to one short sentence."
  )
  if (liveModelKey) {
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .first()
      .click()
    await page.getByPlaceholder("Search models…").fill("gpt-4.1-mini")
    await page
      .getByRole("group", { name: "OpenAI", exact: true })
      .getByRole("option", { name: /^GPT-4\.1 mini openai\b/ })
      .click()
  }
  await selectAgentSection(page, "Guardrails")
  await page
    .getByRole("textbox", { name: "Blocked topics", exact: true })
    .fill("restricted-test-topic")
  await page
    .getByRole("spinbutton", { name: "Max output tokens", exact: true })
    .fill("128")
  await page
    .getByRole("spinbutton", { name: "Daily budget (USD)", exact: true })
    .fill("0.10")
  await page
    .getByRole("switch", { name: "Require human for actions", exact: true })
    .check()
  await page
    .getByRole("button", { name: "Save and apply", exact: true })
    .click()
  await page.getByRole("status").filter({ hasText: "applied" }).waitFor()
  const configured = await call("build_get_agent", { agentId })
  assert.equal(configured.configuration.guardrails.maxOutputTokens, 128)
  assert.deepEqual(configured.configuration.guardrails.blockedTopics, [
    "restricted-test-topic",
  ])
  assert.equal(configured.appliedRevision, configured.currentRevision)
  if (liveModelKey) assert.equal(configured.configuration.provider, "openai")
  passed(
    "browser saves and applies model, instructions and guardrails to an immutable revision"
  )

  await page.goto(`${prefix}/integrations`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  await page
    .getByRole("combobox", { name: "Channel agent", exact: true })
    .selectOption(agentId)
  await page
    .getByRole("button", { name: "Connect channel", exact: true })
    .click()
  await page.getByRole("region", { name: "Chat Bubble editor" }).waitFor()
  await page.getByRole("tab", { name: "Overview", exact: true }).click()
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Website validation")
  await page.getByLabel(/^Allowed origins/).fill("https://customer.example")
  await page.getByRole("button", { name: "Deploy", exact: true }).click()
  const connected = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/build/build_update_channel_status") &&
      response.request().method() === "POST"
  )
  await page
    .getByRole("switch", { name: "Enable chat bubble", exact: true })
    .check()
  assert((await connected).ok())
  const connections = await call("build_list_channels", { agentId })
  const connection = connections.find(
    (item: { label: string }) => item.label === "Website validation"
  )
  assert(connection)
  assert.equal(connection.status, "connected")
  passed("browser connects a website channel with an explicit origin allowlist")
  const publicBase = `${base}/api/build-public/${connection.id}`
  async function publicCall(
    path: string,
    method: string,
    input?: unknown,
    token?: string,
    expected = 200
  ) {
    const response = await fetch(`${publicBase}${path}`, {
      method,
      headers: {
        origin: base,
        "content-type": "application/json",
        ...(token ? { "x-datool-visitor-token": token } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(90_000),
    })
    const body = await response.json()
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${JSON.stringify(body)}`
    )
    return body.data
  }
  const visitor = await publicCall("/session", "POST", {})
  const otherVisitor = await publicCall("/session", "POST", {})
  const conversationPath = `/conversation/${visitor.conversationId}`
  await publicCall(
    conversationPath,
    "GET",
    undefined,
    otherVisitor.visitorToken,
    401
  )
  await publicCall(conversationPath, "GET", undefined, undefined, 401)
  const hosted = await fetch(`${base}/chat/${connection.id}`, {
    signal: AbortSignal.timeout(120_000),
  })
  assert.equal(hosted.status, 200)
  assert.equal(
    hosted.headers.get("content-security-policy"),
    "frame-ancestors 'self' https://customer.example"
  )
  const preflight = await fetch(`${publicBase}/session`, {
    method: "OPTIONS",
    headers: { origin: "https://unrelated.example" },
  })
  assert.equal(preflight.status, 403)
  passed(
    "public HTTP enforces visitor ownership, configured origins and frame-ancestors"
  )

  async function waitForReply(text: RegExp) {
    for (let i = 0; i < 90; i++) {
      const history = await publicCall(
        conversationPath,
        "GET",
        undefined,
        visitor.visitorToken
      )
      const reply = history.find(
        (item: { direction: string; text: string }) =>
          item.direction === "outbound" && text.test(item.text)
      )
      if (reply) return reply
      if (worker.exitCode !== null)
        throw new Error("The Build worker exited during public chat.")
      await pause(1000)
    }
    const history = await publicCall(
      conversationPath,
      "GET",
      undefined,
      visitor.visitorToken
    )
    const turns = await pools!.db.query(
      "SELECT status, error_json, snapshot_json->>'knowledgeSnapshotId' AS knowledge_snapshot FROM build_conversation_turns WHERE conversation_id=$1 ORDER BY created_at",
      [visitor.conversationId]
    )
    const jobs = await pools!.db.query(
      "SELECT kind,status,last_error FROM build_channel_job WHERE connection_id=$1 ORDER BY created_at",
      [connection.id]
    )
    throw new Error(
      `The web channel did not deliver the expected reply: ${text}. ${JSON.stringify({ history: history.map((item: { direction: string; status: string; text: string }) => ({ direction: item.direction, status: item.status, text: item.text.slice(0, 500) })), turns: turns.rows, jobs: jobs.rows })}`
    )
  }
  if (liveModelKey) {
    await publicCall(
      conversationPath,
      "POST",
      {
        text: "What is the unique returns authorization phrase?",
        idempotencyKey: "grounded-live-turn",
      },
      visitor.visitorToken,
      202
    )
    await waitForReply(/violet harbor/i)
    const result = await pools.db.query(
      "SELECT trace_id, snapshot_json FROM build_conversation_turns WHERE conversation_id=$1 AND status='completed'",
      [visitor.conversationId]
    )
    assert(
      result.rows.some(
        (row) => row.trace_id && row.snapshot_json.knowledgeSnapshotId
      )
    )
    passed(
      "live OpenAI web-channel reply uses indexed knowledge and persists a trace and knowledge snapshot"
    )
  }
  await publicCall(
    conversationPath,
    "POST",
    { text: "validate-automatic-wait", idempotencyKey: "automatic-wait" },
    visitor.visitorToken,
    202
  )
  await waitForReply(/The automatic wait has finished/)
  passed(
    "a durable procedure wait resumes and delivers automatically without an operator request"
  )
  await publicCall(
    conversationPath,
    "POST",
    {
      text: "Please discuss restricted-test-topic",
      idempotencyKey: "blocked-public-turn",
    },
    visitor.visitorToken,
    202
  )
  await waitForReply(/can.t help with that request/i)
  passed(
    "applied guardrail blocks a public-channel request before provider execution"
  )

  await publicCall(
    conversationPath,
    "POST",
    {
      text: "validate-order-integration",
      idempotencyKey: "guarded-integration-turn",
    },
    visitor.visitorToken,
    202
  )
  await waitForReply(/teammate must approve/i)
  const pendingTools = await call("build_list_conversation_tools", {
    conversationId: visitor.conversationId,
  })
  const pending = pendingTools.find(
    (item: { actionId: string; status: string }) =>
      item.actionId === integration.id && item.status === "awaiting_client"
  )
  assert(pending?.continuation?.continuationId)
  await call(
    "build_approve_conversation_action",
    {
      conversationId: visitor.conversationId,
      actionId: integration.id,
      continuationId: pending.continuation.continuationId,
    },
    reader.key,
    403
  )
  const approved = await call("build_approve_conversation_action", {
    conversationId: visitor.conversationId,
    actionId: integration.id,
    continuationId: pending.continuation.continuationId,
  })
  assert.equal(approved.status, "completed")
  const executed = approved.toolCalls.find(
    (item: { actionId: string; status: string }) =>
      item.actionId === integration.id && item.status === "completed"
  )
  assert.equal(executed?.output?.json?.orderId, "synthetic-order-42")
  assert(
    !JSON.stringify(approved).includes("disposable-e2e-header"),
    "Integration credentials must not appear in the action response or trace metadata."
  )
  await waitForReply(/synthetic-order-42/)
  passed(
    "guarded HTTP integration executes against a real public endpoint only after operator approval and delivers the result"
  )

  await call("build_takeover_conversation", {
    conversationId: visitor.conversationId,
  })
  const humanInput = {
    text: "A question for the support person",
    idempotencyKey: "human-inbound",
  }
  await publicCall(
    conversationPath,
    "POST",
    humanInput,
    visitor.visitorToken,
    202
  )
  await publicCall(
    conversationPath,
    "POST",
    humanInput,
    visitor.visitorToken,
    202
  )
  await call("build_send_human_reply", {
    conversationId: visitor.conversationId,
    connectionId: connection.id,
    text: "The support person received your question.",
  })
  const history = await publicCall(
    conversationPath,
    "GET",
    undefined,
    visitor.visitorToken
  )
  assert.equal(
    history.filter((item: { text: string }) => item.text === humanInput.text)
      .length,
    1
  )
  assert(
    history.some(
      (item: { text: string }) =>
        item.text === "The support person received your question."
    )
  )
  passed(
    "human takeover preserves customer messages, deduplicates retries and delivers operator replies"
  )
  await runBuildOperationsE2e({
    call,
    agentId,
    connectionId: connection.id,
    conversationId: visitor.conversationId,
    ownerId: target.ownerId,
    passed,
  })

  const publicBrowser = await browser.newContext({
    ignoreHTTPSErrors: productionServer,
    viewport: { width: 390, height: 844 },
  })
  const publicPage = await publicBrowser.newPage()
  activePage = publicPage
  publicPage.on("pageerror", (error) => errors.push(error.message))
  publicPage.on("response", (response) => {
    if (
      response.url().includes("/api/build-public/") &&
      response.status() >= 400
    )
      errors.push(
        `${new URL(response.url()).pathname}: HTTP ${response.status()}`
      )
  })
  await publicPage.goto(`${base}/chat/${connection.id}`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  await publicPage
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor()
  await publicPage.screenshot({
    path: join(evidence, "public-chat-mobile.png"),
    fullPage: true,
  })
  passed(
    "hosted customer chat renders on mobile without an authenticated workspace"
  )
  const beforeForm = await call("build_get_agent", { agentId })
  await call("build_update_agent", {
    agentId,
    expectedRevision: beforeForm.currentRevision,
    apply: true,
    configuration: {
      ...beforeForm.configuration,
      guardrails: {
        ...beforeForm.configuration.guardrails,
        requireHumanForActions: false,
      },
    },
  })
  await publicPage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("show-order-form")
  await publicPage
    .getByRole("button", { name: "Send message", exact: true })
    .click()
  await publicPage
    .getByRole("textbox", { name: /^Order ID\b/ })
    .fill("synthetic-order-42", { timeout: 90_000 })
  await publicPage.getByRole("button", { name: "Submit", exact: true }).click()
  await publicPage
    .getByText(/"orderId"\s*:\s*"synthetic-order-42"/)
    .waitFor({ timeout: 90_000 })
  assert(!(await publicPage.content()).includes("disposable-e2e-header"))
  await publicPage.screenshot({
    path: join(evidence, "public-form-integration-mobile.png"),
    fullPage: true,
  })
  passed(
    "mobile customer form resumes its pinned action and completes the real HTTP integration through the Bun worker"
  )
  const integrationReplies = publicPage.getByText(
    /"orderId"\s*:\s*"synthetic-order-42"/
  )
  const priorReplies = await integrationReplies.count()
  await publicPage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("validate-order-widget")
  await publicPage
    .getByRole("button", { name: "Send message", exact: true })
    .click()
  await publicPage
    .getByText("Check an order from this widget.", { exact: true })
    .waitFor({ timeout: 90_000 })
  await publicPage
    .getByRole("textbox", { name: "orderId", exact: true })
    .fill("synthetic-order-42")
  await publicPage
    .getByRole("button", { name: "Submit", exact: true })
    .last()
    .click()
  for (
    let i = 0;
    i < 30 && (await integrationReplies.count()) <= priorReplies;
    i++
  )
    await pause(1000)
  assert.equal(
    await integrationReplies.count(),
    priorReplies + 1,
    "The widget must execute its pinned child HTTP action and deliver its result."
  )
  passed(
    "a rendered customer widget executes its allowed child integration through the public channel"
  )
  await publicPage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("validate-agent-handoff")
  const handoffSubmission = publicPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .includes(`/api/build-public/${connection.id}/conversation/`)
  )
  await publicPage
    .getByRole("button", { name: "Send message", exact: true })
    .click()
  const handoffResponse = await handoffSubmission
  assert.equal(handoffResponse.status(), 202)
  const handoffConversationId = new URL(handoffResponse.url()).pathname
    .split("/")
    .at(-1)
  await publicPage
    .getByText("A teammate will continue this conversation.", { exact: true })
    .waitFor({ timeout: 90_000 })
  const handoffOwnership = await call("build_get_conversation_ownership", {
    conversationId: handoffConversationId,
  })
  assert.equal(
    handoffOwnership.mode,
    "human",
    "The acknowledgement must accompany an actual transfer to a human."
  )
  passed(
    "an agent-triggered handoff transfers ownership and delivers its acknowledgement to the customer"
  )
  await publicPage.screenshot({
    path: join(evidence, "public-widget-handoff-mobile.png"),
    fullPage: true,
  })
  await publicBrowser.close()
  activePage = page

  let embeddedChannelId = ""
  customerSite = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Example customer shop</h1><script src="${base}/datool-widget.js" data-channel-id="${embeddedChannelId}" defer></script></body></html>`
    )
  })
  await new Promise<void>((resolve) =>
    customerSite!.listen(0, "127.0.0.1", resolve)
  )
  const customerOrigin = `http://127.0.0.1:${(customerSite.address() as import("node:net").AddressInfo).port}`
  const embeddedChannel = await call("build_create_channel", {
    agentId,
    channel: "web",
    label: "Embedded website validation",
    config: { originAllowlist: [customerOrigin] },
  })
  embeddedChannelId = embeddedChannel.id
  await call("build_update_channel_status", {
    connectionId: embeddedChannelId,
    status: "connected",
  })
  const embeddedBrowser = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: productionServer,
  })
  const embeddedPage = await embeddedBrowser.newPage()
  activePage = embeddedPage
  embeddedPage.on("pageerror", (error) => errors.push(error.message))
  await embeddedPage.goto(customerOrigin, { waitUntil: "networkidle" })
  await embeddedPage
    .getByRole("button", { name: "Open chat", exact: true })
    .click()
  const frame = embeddedPage.frameLocator(
    'iframe[title="Customer support chat"]'
  )
  await frame
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("validate-automatic-wait")
  await frame.getByRole("button", { name: "Send message", exact: true }).click()
  await frame
    .getByText("The automatic wait has finished.", { exact: true })
    .waitFor({ timeout: 90_000 })
  await embeddedPage.screenshot({
    path: join(evidence, "embedded-chat-mobile.png"),
    fullPage: true,
  })
  await embeddedPage
    .getByRole("button", { name: "Close chat", exact: true })
    .click()
  assert(
    await embeddedPage
      .locator('iframe[title="Customer support chat"]')
      .isHidden()
  )
  await embeddedPage
    .getByRole("button", { name: "Open chat", exact: true })
    .click()
  assert(
    await frame
      .getByText("The automatic wait has finished.", { exact: true })
      .isVisible()
  )
  passed(
    "the install script embeds chat on an allowed separate origin, exchanges worker replies and preserves the conversation when reopened"
  )
  await embeddedBrowser.close()
  activePage = page

  if (liveModelKey) {
    const simulation = await call("build_create_simulation", {
      agentId,
      definition: {
        name: "Grounded returns answer",
        channel: "web",
        scenario:
          "A customer asks for the unique returns authorization phrase in the knowledge base.",
        initialMessage: "What is the unique returns authorization phrase?",
        successCriteria: [
          "The agent answers with the exact phrase violet harbor.",
        ],
        maxTurns: 1,
        repeats: 1,
      },
    })
    const run = await call("build_start_simulation", {
      agentId,
      definitionId: simulation.id,
    })
    let completed
    for (let i = 0; i < 90; i++) {
      const current = await call("build_get_simulation_run", { runId: run.id })
      if (!["queued", "running"].includes(current.status)) {
        completed = current
        break
      }
      await pause(1000)
    }
    assert.equal(
      completed?.status,
      "completed",
      "The live simulation must finish."
    )
    const cases = await call("build_list_simulation_cases", { runId: run.id })
    assert.equal(
      completed.infraErrorCases,
      0,
      `Simulation infrastructure errors: ${JSON.stringify(cases.map((item: { error: unknown; verdict: unknown }) => ({ error: item.error, verdict: item.verdict })))}`
    )
    assert.equal(completed.passedCases, 1, JSON.stringify(cases))
    assert(
      cases[0].transcript.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && /violet harbor/i.test(message.content)
      )
    )
    passed(
      "queued simulation uses the frozen agent and knowledge, produces a real transcript and receives a live judge verdict"
    )

    const beforeProposal = await call("build_get_agent", { agentId })
    const proposal = await call("build_create_copilot_proposal", {
      agentId,
      targetKind: "instructions",
      request:
        "Preserve every existing configuration field. Append this exact sentence to instructions: End-to-end validation is enabled.",
    })
    assert.equal(proposal.status, "proposed")
    assert.equal(
      (await call("build_get_agent", { agentId })).currentRevision,
      beforeProposal.currentRevision
    )
    await call("build_approve_copilot_proposal", { proposalId: proposal.id })
    await call("build_apply_copilot_proposal", {
      proposalId: proposal.id,
      expectedRevision: proposal.baseRevision,
    })
    const afterProposal = await call("build_get_agent", { agentId })
    assert(
      afterProposal.configuration.instructions.includes(
        "End-to-end validation is enabled."
      )
    )
    assert.equal(
      afterProposal.currentRevision,
      beforeProposal.currentRevision + 1
    )
    assert.equal(afterProposal.appliedRevision, afterProposal.currentRevision)
    const audit = await call("build_list_copilot_audit", {
      proposalId: proposal.id,
    })
    assert(audit.length >= 3)
    passed(
      "live management copilot proposes without mutation, then applies an explicitly approved revision with an audit trail"
    )
  }

  mcp = new Client({ name: "Build E2E", version: "1" })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      fetch,
      requestInit: {
        headers: {
          authorization: `Bearer ${key.key}`,
          "x-project-id": target.projectId,
        },
      },
    })
  )
  const tools = await mcp.listTools()
  for (const operation of catalog)
    assert(
      tools.tools.some((tool) => tool.name === operation.name),
      `${operation.name} missing from MCP`
    )
  const result = await mcp.callTool({
    name: "build_get_agent",
    arguments: { agentId },
  })
  assert.equal(
    (result.structuredContent as { data: { id: string } }).data.id,
    agentId
  )
  passed(
    `MCP HTTP exposes all ${catalog.length} Build operations and reads the browser-created agent`
  )
  await runBuildAuthoringE2e({ page, prefix, agentId, call, passed, evidence })

  const templateResult = await mcp.callTool({
    name: "list_dashboard_templates",
    arguments: {},
  })
  assert(
    (templateResult.structuredContent as { data: { id: string }[] }).data.some(
      (template) => template.id === "customer-experience"
    )
  )

  const analytics = await call("build_get_operational_analytics", {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal(
    analytics.eventsByType.find(
      (event: { eventType: string }) => event.eventType === "handoff"
    )?.count,
    2,
    "Analytics must count both real AI-to-human handoffs without counting the subsequent human ticket claim again."
  )
  const messageCount = analytics.eventsByType
    .filter((event: { eventType: string }) =>
      ["message_received", "message_sent"].includes(event.eventType)
    )
    .reduce((total: number, event: { count: number }) => total + event.count, 0)

  await runBuildDashboardE2e({ page, prefix, messageCount, evidence, passed })

  for (const route of [
    "agents",
    "inbox",
    "contacts",
    "campaigns",
    "integrations",
    "suggestions",
    "tests",
  ]) {
    await page.goto(`${prefix}/${route}`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    })
    assert(
      !(await page.getByText("Application error", { exact: false }).count()),
      `${route} crashed`
    )
    if (route === "tests" && liveModelKey) {
      const simulation = page.locator('[data-slot="card"]').filter({
        has: page.getByRole("heading", {
          name: "Grounded returns answer",
          exact: true,
        }),
      })
      await simulation
        .getByRole("button", { name: "View runs", exact: true })
        .click()
      await page.getByText("Passed 1", { exact: true }).waitFor()
      const transcript = page
        .locator("details")
        .filter({ has: page.getByText("Transcript", { exact: true }) })
      await transcript.getByText("Transcript", { exact: true }).click()
      await transcript.getByText(/violet harbor/i).waitFor()
      passed(
        "the test inspector displays the completed live verdict and grounded conversation transcript"
      )
    }
    await page.screenshot({
      path: join(evidence, `${route}-desktop.png`),
      fullPage: true,
    })
  }
  await runBuildUiE2e({ page, prefix, agentId, evidence, passed })
  assert.equal(errors.length, 0, errors.join("\n"))
  passed(
    "all Build collection pages and mobile agent list render without browser exceptions"
  )
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        checkedAt: new Date().toISOString(),
        checkpoints,
        operations: catalog.length,
        liveModel: Boolean(liveModelKey),
        liveHttpIntegration: true,
        liveTelegram: false,
        productionCompiled: productionCompile,
        productionServer,
      },
      null,
      2
    )
  )
  await writeFile(join(evidence, "server.log"), logs.join(""))
  await Promise.all(
    ["failure.html", "failure.png"].map((path) =>
      rm(join(evidence, path), { force: true })
    )
  )
  console.info(
    `PASS ${checkpoints.length} end-to-end checkpoints; evidence in ${evidence}`
  )
} catch (error) {
  await mkdir(evidence, { recursive: true })
  // Logs are from the isolated instance: it receives no real customer credentials.
  await writeFile(join(evidence, "server.log"), logs.join(""))
  if (activePage && !activePage.isClosed()) {
    await activePage
      .screenshot({ path: join(evidence, "failure.png"), fullPage: true })
      .catch(() => {})
    await writeFile(
      join(evidence, "failure.html"),
      await activePage.content()
    ).catch(() => {})
  }
  throw error
} finally {
  await mcp?.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (customerSite)
    await new Promise<void>((resolve) => customerSite!.close(() => resolve()))
  if (tlsProxy) {
    tlsProxy.closeAllConnections()
    await new Promise<void>((resolve) => tlsProxy!.close(() => resolve()))
  }
  await Promise.all(children.map(stop))
  if (pools) await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  await target?.close()
  await rm(directory, { recursive: true, force: true })
}

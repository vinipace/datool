/** Real MCP + CLI + saved editor + opaque browser runtime, on disposable PostgreSQL. */
import "next/dist/server/node-environment-baseline"
import assert from "node:assert/strict"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { makeSignature } from "better-auth/crypto"
import { chromium, type Browser, type Page } from "playwright"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { permissionStatements } from "../src/lib/auth/permissions"
import type { WidgetDefinition, WidgetRecord } from "../src/lib/build/contracts"
import type { WidgetPreviewReport } from "../src/lib/build/widget-validation"
import { runWidgetAuthoringEval } from "./widget-authoring-eval"

const live = process.argv.includes("--live-model")
const liveKey = live ? process.env.OPENAI_API_KEY : undefined
if (live) assert(liveKey, "--live-model requires OPENAI_API_KEY")
const target = await createIsolatedPostgres()
const socket = createServer()
await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done))
const port = (socket.address() as { port: number }).port
await new Promise<void>((done) => socket.close(() => done()))
const base = `http://127.0.0.1:${port}`
const output = resolve("artifacts/widget-authoring-e2e")
await mkdir(output, { recursive: true })
// The fixture must not inherit customer credentials or remote service URLs.
for (const name of Object.keys(process.env)) {
  if (
    /^(REDIS_|UPSTASH_|GOOGLE_|OPENAI_|AI_GATEWAY_|ANTHROPIC_|STRIPE_|PAYLOAD_|DATOOL_PROVIDER_|DATOOL_API_KEY|DATOOL_BASE_URL)/.test(
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
  DATOOL_BUILD_ENABLED: "true",
  DATOOL_BILLING_ENABLED: "false",
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  DATOOL_DIST_DIR: ".next-widget-authoring-e2e",
})
const originals = await Promise.all(
  ["tsconfig.json", "next-env.d.ts"].map(
    async (path) => [path, await readFile(path, "utf8")] as const
  )
)
const pools = await import("../lib/db")
let server: ChildProcess | undefined,
  browser: Browser | undefined,
  page: Page | undefined,
  mcp: Client | undefined
let log = ""
const checkpoints: string[] = []
const passed = (label: string) => {
  checkpoints.push(label)
  console.info(`PASS ${label}`)
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const preview = async (input: Record<string, unknown>) => {
  assert(page)
  return page.evaluate(async (args) => {
    const tools = (
      window as unknown as {
        widgetTools: Record<
          string,
          {
            execute(
              input: unknown
            ): Promise<{ isError?: boolean; content: { text: string }[] }>
          }
        >
      }
    ).widgetTools
    const result = await tools.build_validate_widget_preview.execute(args)
    if (result.isError) throw new Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }, input) as Promise<WidgetPreviewReport & { revision?: number }>
}
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const key = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Widget authoring fixture",
      permissions: permissionStatements(["build:read", "build:write"]),
      rateLimitMax: 10000,
    },
  })
  const authContext = await auth.$context
  const session = await authContext.internalAdapter.createSession(
    target.ownerId
  )
  assert(session)
  await pools.db.query(
    'update session set "activeOrganizationId"=$1 where id=$2',
    [target.organizationId, session.id]
  )
  const cookie = encodeURIComponent(
    `${session.token}.${await makeSignature(session.token, authContext.secret)}`
  )
  server = spawn(
    process.execPath,
    [
      "run",
      "next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
  )
  for (const stream of [server.stdout, server.stderr])
    stream?.on("data", (data) => {
      log = (log + String(data)).slice(-120000)
    })
  const deadline = Date.now() + 180000
  while (true) {
    if (server.exitCode !== null)
      throw new Error(`Next exited: ${log.slice(-2000)}`)
    try {
      if (
        (await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(20000) }))
          .ok
      )
        break
    } catch {
      /* starting */
    }
    assert(Date.now() < deadline, `Next startup timeout: ${log.slice(-2000)}`)
    await pause(500)
  }
  const headers = {
    authorization: `Bearer ${key.key}`,
    "x-project-id": target.projectId,
    "content-type": "application/json",
  }
  const api = async <T>(name: string, input: unknown): Promise<T> => {
    const response = await fetch(`${base}/api/build/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    })
    const result = await response.json()
    assert(response.ok, JSON.stringify(result))
    return result.data as T
  }
  const agent = await api<{ id: string }>("build_create_agent", {
    name: "Widget authoring evaluation",
    configuration: { instructions: "Synthetic widget authoring fixture" },
    requestKey: crypto.randomUUID(),
  })
  mcp = new Client({ name: "Widget authoring evaluation", version: "1" })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: { headers },
    })
  )
  const catalog = (await mcp.listTools()).tools
  const call = async <T>(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<T> => {
    const result = await mcp!.callTool({ name, arguments: input })
    assert(!result.isError, JSON.stringify(result.content))
    return (result.structuredContent as { data: T }).data
  }
  const listed = await call<Array<{ id: string }>>(
    "build_list_widget_templates",
    { search: "products" }
  )
  assert(listed.length > 0)
  const { definition } = await call<{ definition: WidgetDefinition }>(
    "build_get_widget_template",
    { templateId: listed[0].id }
  )
  const components = await call<{
    components: Array<{ name: string; example: string }>
  }>("build_get_widget_components")
  assert(
    components.components.some(
      (item) => item.name === "Image" && item.example.includes("src=")
    )
  )
  const cliEnv = {
    ...process.env,
    DATOOL_API_KEY: key.key,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_BASE_URL: base,
    DATOOL_NO_ENV: "1",
  }
  const cli = await promisify(execFile)(
    process.execPath,
    [
      "--no-env-file",
      "bin/datool.ts",
      "build",
      "call",
      "build_get_widget_template",
      "--input",
      JSON.stringify({ templateId: listed[0].id }),
      "--no-env",
    ],
    { env: cliEnv, maxBuffer: 2_000_000 }
  )
  assert(cli.stdout.includes(definition.name))
  passed(
    "MCP discovers templates/components and CLI retrieves the same complete product template"
  )

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  context.setDefaultNavigationTimeout(120000)
  await context.addInitScript(() => {
    const tools: Record<string, unknown> = {}
    Object.defineProperty(window, "widgetTools", { value: tools })
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool(tool: { name: string }) {
          tools[tool.name] = tool
        },
        unregisterTool(name: string) {
          delete tools[name]
        },
      },
    })
  })
  await context.addCookies([
    {
      name: authContext.authCookies.sessionToken.name,
      value: cookie,
      url: base,
    },
  ])
  page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() === "error") log += `\nBrowser: ${message.text()}`
  })
  page.on("requestfailed", (request) => {
    log += `\nRequest failed: ${request.url()} ${request.failure()?.errorText}`
  })
  await page.goto(
    `${base}/p/test-project/build/agents/${agent.id}?section=widgets`
  )
  // Wait for the real Widgets route, including its WebMCP registration.
  await page.getByRole("tab", { name: "My widgets", exact: true }).waitFor()
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { widgetTools: Record<string, unknown> })
        .widgetTools.build_validate_widget_preview
    )
  )
  for (const width of [360, 768]) {
    const result = await preview({ definition, width })
    assert.equal(result.valid, true, JSON.stringify(result))
    assert(result.rendered && result.schemaValidated)
    assert.equal(result.imageCount, 2)
    assert(result.text?.includes("Everyday trainer"))
  }
  passed(
    "Actual template images, schema and content render at mobile and desktop widths"
  )

  // Negative controls exercise the same browser tool and runtime as the positive template.
  const empty = {
    ...definition,
    code: "export default function Widget({data}) { return <Row>{data.products.map(p => <Text key={p.id}>{p.name}</Text>)}</Row> }",
    states: { default: { ...definition.states.default, products: [] } },
  }
  const invalidData = {
    ...definition,
    states: { default: { ...definition.states.default, products: "wrong" } },
  }
  const brokenImage = {
    ...definition,
    code: 'export default function Widget() { return <Image src="/widget-template-assets/does-not-exist.webp" alt="Missing product" /> }',
  }
  const overflow = {
    ...definition,
    code: "export default function Widget() { return <Box width={2000}><Text>Too wide</Text></Box> }",
  }
  const badToken = {
    ...definition,
    code: 'export default function Widget() { return <a style={{background: "var(--color-primary)", color: "var(--color-on-primary)"}}>View product</a> }',
  }
  for (const [candidate, code] of [
    [empty, "empty_preview"],
    [invalidData, "render_error"],
    [brokenImage, "image_failed"],
    [overflow, "horizontal_overflow"],
    [badToken, "undefined_style_variable"],
  ] as const) {
    const result = await preview({ definition: candidate })
    assert.equal(result.valid, false, JSON.stringify(result))
    assert(
      result.diagnostics.some((item) => item.code === code),
      JSON.stringify(result)
    )
  }
  assert.equal(
    (await preview({ definition: empty, allowEmpty: true })).valid,
    true
  )
  const staticCheck = await call<{
    rendered: boolean
    schemaValidated: boolean
    diagnostics: { code: string }[]
  }>("build_validate_widget", { definition: empty })
  assert.equal(staticCheck.rendered, false)
  assert.equal(staticCheck.schemaValidated, false)
  assert(
    staticCheck.diagnostics.some((item) => item.code === "empty_example_data")
  )
  passed(
    "Empty output, bad schema data, missing images, undefined style variables and overflow fail; intentional empty preview is explicit"
  )

  const saved = await call<WidgetRecord>("build_save_widget", {
    agentId: agent.id,
    definition,
    requestKey: crypto.randomUUID(),
  })
  const read = await call<WidgetRecord>("build_get_widget", {
    agentId: agent.id,
    widgetId: saved.id,
  })
  assert.deepEqual(read.definition.states.default, definition.states.default)
  assert.equal((await preview({ widgetId: saved.id })).revision, saved.revision)
  // Reopen persisted editor rather than relying on the candidate fixture alone.
  await page.reload()
  await page.getByRole("button", { name: definition.name, exact: true }).click()
  await page
    .frameLocator('iframe[title="Widget content"]')
    .getByText("Everyday trainer", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "Check preview", exact: true }).click()
  await page
    .getByText("Preview checks passed. Review its appearance before saving.", {
      exact: true,
    })
    .waitFor()
  await page.screenshot({ path: `${output}/saved-preview-light.png` })
  await page.getByRole("button", { name: "Dark preview", exact: true }).click()
  await page.getByRole("button", { name: "Check preview", exact: true }).click()
  await page
    .getByText("Preview checks passed. Review its appearance before saving.", {
      exact: true,
    })
    .waitFor()
  await page.screenshot({ path: `${output}/saved-preview-dark.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePreview = page.getByRole("button", {
    name: "Preview",
    exact: true,
  })
  if (await mobilePreview.count()) await mobilePreview.click()
  await page
    .frameLocator('iframe[title="Widget content"]')
    .getByText("Everyday trainer", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "Check preview", exact: true }).click()
  await page
    .getByText("Preview checks passed. Review its appearance before saving.", {
      exact: true,
    })
    .waitFor()
  await page.screenshot({ path: `${output}/saved-preview-mobile.png` })
  passed(
    "Saved revision reopens populated; editor Check preview passes in light/dark and mobile screenshot is captured"
  )

  const bad = await call<WidgetRecord>("build_save_widget", {
    agentId: agent.id,
    definition: { ...empty, name: "Empty preview regression" },
    requestKey: crypto.randomUUID(),
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(
    `${base}/p/test-project/build/agents/${agent.id}?section=widgets`
  )
  await page
    .getByRole("button", { name: "Empty preview regression", exact: true })
    .click()
  await page.getByRole("button", { name: "Check preview", exact: true }).click()
  await page
    .getByRole("status")
    .filter({ hasText: "The widget rendered no visible content" })
    .waitFor()
  await page.screenshot({ path: `${output}/empty-preview-error.png` })
  assert.equal((await preview({ widgetId: bad.id })).valid, false)
  passed(
    "Saved empty default is reported visibly in the editor, without substituting sample products"
  )

  let liveReport: unknown = { ran: false }
  if (liveKey) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(
      `${base}/p/test-project/build/agents/${agent.id}?section=widgets`
    )
    await page.getByRole("tab", { name: "My widgets", exact: true }).waitFor()
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as { widgetTools: Record<string, unknown> })
          .widgetTools.build_validate_widget_preview
      )
    )
    liveReport = await runWidgetAuthoringEval({
      apiKey: liveKey,
      agentId: agent.id,
      catalog,
      call,
      preview,
      page,
      output,
    })
    passed(
      "Live authoring model discovers, adapts, validates, saves and rereads a product widget through public tools"
    )
  }
  await writeFile(
    `${output}/report.json`,
    JSON.stringify({ status: "passed", checkpoints, liveReport }, null, 2)
  )
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      { status: "failed", checkpoints, error: String(error) },
      null,
      2
    )
  )
  throw error
} finally {
  await writeFile(`${output}/server.log`, log)
  await mcp?.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([
      new Promise<void>((done) => server!.once("exit", () => done())),
      pause(10000),
    ])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  for (const [path, content] of originals) await writeFile(path, content)
  await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  await target.close()
}

/** Real browser -> API -> Redis ingestion -> PostgreSQL outbox -> worker -> HTTP receiver.
 * Run only with disposable DATOOL_TEST_DATABASE_URL and DATOOL_TEST_REDIS_URL.
 */
import assert from "node:assert/strict"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { createServer, request as proxyRequest } from "node:http"
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { Pool } from "pg"
import { chromium, type Browser } from "playwright"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "../tests/helpers/postgres"
import type { AlertsResponse } from "../src/lib/alerts/contracts"
import { createTestAlertReader } from "../tests/helpers/alert-reader"

const redisUrl = process.env.DATOOL_TEST_REDIS_URL
if (
  !redisUrl ||
  !["localhost", "127.0.0.1"].includes(new URL(redisUrl).hostname) ||
  redisUrl === process.env.REDIS_URL
)
  throw new Error(
    "Set DATOOL_TEST_REDIS_URL to a disposable loopback Redis, separate from REDIS_URL."
  )
const target = await createIsolatedPostgres()
let reader: Awaited<ReturnType<typeof createTestAlertReader>> | undefined
const pool = new Pool({ connectionString: target.databaseUrl })
const output = resolve("artifacts/alerts-e2e")
await mkdir(output, { recursive: true })
const base = `http://127.0.0.1:${process.env.DATOOL_ALERT_E2E_PORT ?? "3059"}`
const projectId = crypto.randomUUID()
const apiKey = `alert-local-e2e-${crypto.randomUUID()}`
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: target.databaseUrl,
  REDIS_URL: redisUrl,
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: "local-alert-browser-proof-secret-at-least-32-characters",
  DATOOL_PROJECT_ID: projectId,
  DATOOL_API_KEY: apiKey,
  DATOOL_ALERT_LOCAL_WEBHOOKS: "1",
  DATOOL_DIST_DIR: ".next-alerts-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
}
const originalTsconfig = await readFile("tsconfig.json", "utf8")
const originalNextEnv = await readFile("next-env.d.ts", "utf8")
const children: ChildProcess[] = []
let serverLog = ""
let workerLog = ""
let browser: Browser | undefined
let productionProxy: HttpsServer | undefined
let certificateDirectory: string | undefined
const received: {
  deliveryId: string
  status: number
  payload: Record<string, unknown>
}[] = []
const receiver = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  const status = received.length === 0 ? 503 : 204
  received.push({
    deliveryId: String(request.headers["idempotency-key"]),
    status,
    payload,
  })
  response.writeHead(status)
  response.end()
})
await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done))
const webhookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/alerts`
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function until(check: () => Promise<boolean>, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(300)
  }
  throw new Error("Timed out waiting for end-to-end assertion")
}
function start(
  args: string[],
  kind: "server" | "worker",
  environment: NodeJS.ProcessEnv = env
) {
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      if (kind === "server") serverLog += String(chunk)
      else workerLog += String(chunk)
    })
  return child
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  await new Promise<void>((done) => child.once("exit", () => done()))
  clearTimeout(timer)
}
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment:
    "Isolated local PostgreSQL and Redis; real Next app, ingestion worker and webhook receiver",
}
try {
  await migrateIsolatedPostgres(target)
  reader = await createTestAlertReader(target)
  env.DATOOL_ALERT_DATABASE_URL = reader.databaseUrl
  proof.restrictedReader = true
  const seeded = await promisify(execFile)(
    process.execPath,
    ["run", "tests/helpers/alerts-browser-fixture.ts"],
    { env }
  )
  const fixture = JSON.parse(seeded.stdout.trim())
  const server = start(
    [
      "run",
      "next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(base).port,
    ],
    "server"
  )
  await until(async () => {
    try {
      return (await fetch(`${base}/sign-in`)).ok
    } catch {
      return false
    }
  }, 120000)
  let worker = start(["run", "scripts/ingestion-worker.ts"], "worker")
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    ignoreHTTPSErrors: true,
  })
  await context.addCookies([{ ...fixture.cookie, url: base }])
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(90000)
  const browserErrors: string[] = []
  page.on("pageerror", (error) => browserErrors.push(error.message))
  const alertsPath = `/api/projects/${projectId}/alerts`
  const alerts = async (): Promise<AlertsResponse> => {
    const response = await context.request.get(`${base}${alertsPath}`)
    assert.equal(response.status(), 200)
    return response.json()
  }
  const screenshot = async (name: string) =>
    page.screenshot({
      path: resolve(output, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    })
  const collectionUrl = `${base}/p/alerts-e2e/alerts`
  await page.goto(`${base}/p/alerts-e2e/settings/alerts`)
  await page.waitForURL(collectionUrl)
  await page.getByText("No alerts yet", { exact: true }).waitFor()
  assert.equal(await page.title(), "Alerts · Datool")
  const sidebarToggle = page
    .getByLabel("Page controls", { exact: true })
    .getByRole("button", { name: "Toggle sidebar" })
  if ((await sidebarToggle.getAttribute("aria-expanded")) !== "true")
    await sidebarToggle.click()
  const sidebarLink = page
    .locator("aside")
    .getByRole("link", { name: "Alerts", exact: true })
  await sidebarLink.waitFor({ state: "visible" })
  assert.equal(await sidebarLink.getAttribute("href"), "/p/alerts-e2e/alerts")
  assert.equal(await sidebarLink.getAttribute("aria-current"), "page")
  await screenshot("01-empty")
  await page.getByRole("button", { name: "New alert", exact: true }).click()
  await page.getByRole("dialog", { name: "New alert" }).waitFor()
  assert.equal(
    await page
      .getByRole("radio", { name: "Empty alert", exact: true })
      .isChecked(),
    true
  )
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForURL(`${collectionUrl}/new`)
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "")
  assert.equal(await page.getByLabel("SQL filter clause").inputValue(), "")
  assert.equal(await page.getByRole("radio").count(), 0)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForURL(collectionUrl)
  await page.getByRole("button", { name: "New alert", exact: true }).click()
  await page.getByRole("dialog", { name: "New alert" }).waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  assert.equal(page.url(), collectionUrl)
  await page.getByRole("button", { name: "New alert", exact: true }).click()
  await page.getByText("Request failures", { exact: true }).click()
  await screenshot("02-templates")
  assert.equal((await alerts()).alerts.length, 0)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForURL(`${collectionUrl}/new?template=request-failures`)
  await page.reload()
  await page.getByLabel("Name", { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Request failures"
  )
  assert.equal(await page.getByRole("radio").count(), 0)
  assert.equal(
    await page.getByLabel("SQL filter clause").inputValue(),
    "resource = 'trace' AND status = 'errored'"
  )
  await page
    .getByLabel("Name", { exact: true })
    .fill("Production error webhook")
  await page.getByLabel("Action type").selectOption("webhook")
  await page.getByLabel("Webhook URL").fill(webhookUrl)
  await screenshot("02-create-alert")
  await page.getByRole("button", { name: "Create alert", exact: true }).click()
  await page.waitForURL(/\/alerts\/[a-f0-9-]{36}$/)
  assert.equal((await alerts()).alerts.length, 1)
  const rule = (await alerts()).alerts[0]
  const detailUrl = `${collectionUrl}/${rule.id}`
  assert.equal(page.url(), detailUrl)
  await page.reload()
  await page
    .getByRole("heading", { name: rule.config.name, exact: true })
    .waitFor()
  await page.getByText("No notifications yet", { exact: true }).waitFor()
  assert.equal(await page.title(), "Alert notifications · Datool")
  proof.createdRule = {
    id: rule.id,
    persistedAfterReload: true,
    template: "request-failures",
  }
  // Shared page controls, direct edit URL, validation and unchanged/reverted state.
  await page.getByRole("link", { name: "Edit alert", exact: true }).click()
  await page.waitForURL(`${detailUrl}/edit`)
  await page.reload()
  await page.getByLabel("Name", { exact: true }).waitFor()
  assert.equal(await page.title(), "Edit alert · Datool")
  assert(await page.getByRole("button", { name: "Save changes" }).isDisabled())
  await page.getByLabel("Name", { exact: true }).fill("Changed")
  assert(await page.getByRole("button", { name: "Save changes" }).isEnabled())
  await page.getByLabel("Name", { exact: true }).fill(rule.config.name)
  assert(await page.getByRole("button", { name: "Save changes" }).isDisabled())
  await page.getByLabel("SQL filter clause").fill("name = 'x'; SELECT 1")
  await page
    .getByRole("alert")
    .filter({ hasText: "Unsupported filter syntax" })
    .waitFor()
  assert(await page.getByRole("button", { name: "Save changes" }).isDisabled())
  await page.getByLabel("SQL filter clause").focus()
  await screenshot("03-filter-error-focus")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForURL(detailUrl)
  await page.getByRole("link", { name: "Edit alert", exact: true }).click()
  await page.getByText("Description (optional)", { exact: true }).click()
  await page
    .getByLabel("Description", { exact: true })
    .fill("Notify on failed checkout requests.")
  await page.getByRole("button", { name: "Save changes" }).click()
  await page.waitForURL(detailUrl)
  assert.equal(
    (await alerts()).alerts[0].config.description,
    "Notify on failed checkout requests."
  )

  const ingest = async (name: string, status: string) => {
    const id = crypto.randomUUID()
    const event = {
      id: crypto.randomUUID(),
      previousId: null,
      path: "/api/traces",
      method: "POST",
      body: { id, name, status, startedAt: new Date().toISOString() },
    }
    const response = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-project-id": projectId,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    })
    assert.equal(response.status, 202, await response.text())
    await until(
      async () =>
        (
          await pool.query(
            "SELECT 1 FROM ingestion_receipts WHERE event_id=$1",
            [event.id]
          )
        ).rowCount === 1
    )
    return { traceId: id, event }
  }
  await ingest("Healthy request", "completed")
  await until(
    async () =>
      (await pool.query("SELECT count(*) FROM alert_events")).rows[0].count ===
      "0"
  )
  assert.equal((await alerts()).deliveries.length, 0)
  const errorTrace = await ingest("Failed checkout request", "errored")
  await until(async () => received.length === 1)
  await until(async () => (await alerts()).deliveries[0]?.attempts === 1)
  // Stop and restart the real worker between failed attempt and retry.
  await stop(worker)
  const pending = (await alerts()).deliveries[0]
  assert.equal(pending.status, "pending")
  worker = start(["run", "scripts/ingestion-worker.ts"], "worker")
  await until(
    async () => (await alerts()).deliveries[0]?.status === "delivered"
  )
  assert.equal(received.length, 2)
  assert.equal(received[0].deliveryId, received[1].deliveryId)
  await page.getByText("Delivered", { exact: true }).waitFor({ timeout: 20000 })
  await screenshot("04-webhook-delivered")
  await page
    .getByRole("link", { name: "View trace Failed checkout request" })
    .click()
  await page.waitForURL(`${base}/p/alerts-e2e/traces/${errorTrace.traceId}`)
  await page
    .getByText("Failed checkout request", { exact: true })
    .first()
    .waitFor({ timeout: 90000 })
  assert(page.url().includes(errorTrace.traceId))
  await screenshot("05-triggering-trace")
  await page.goto(collectionUrl)
  await page
    .getByRole("link", { name: rule.config.name, exact: true })
    .waitFor()
  await ingest("Suppressed second error", "errored")
  await until(
    async () =>
      (await pool.query("SELECT count(*) FROM alert_events")).rows[0].count ===
      "0"
  )
  assert.equal(received.length, 2)
  proof.webhook = {
    requests: received,
    workerRestartBetweenAttempts: true,
    nonmatchingIgnored: true,
    cooldownSuppressed: true,
    traceId: errorTrace.traceId,
  }

  // Create the count-based template and adjust its threshold.
  await page.getByRole("button", { name: "New alert", exact: true }).click()
  await page.getByText("Error burst", { exact: true }).click()
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForURL(`${collectionUrl}/new?template=error-burst`)
  assert.equal(
    await page.getByLabel("Minimum matching logs").inputValue(),
    "10"
  )
  await page
    .getByLabel("Name", { exact: true })
    .fill("Error burst in 5 minutes")
  await page.getByLabel("Minimum matching logs").fill("2")
  await screenshot("06-time-window")
  await page.getByRole("button", { name: "Create alert", exact: true }).click()
  await page.waitForURL(/\/alerts\/[a-f0-9-]{36}$/)
  await until(async () =>
    (await alerts()).deliveries.some(
      (delivery) =>
        delivery.alertName === "Error burst in 5 minutes" &&
        delivery.status === "delivered"
    )
  )
  const burst = (await alerts()).deliveries.find(
    (delivery) => delivery.alertName === "Error burst in 5 minutes"
  )!
  assert.equal(burst.payload.matchCount, 2)
  await page.getByText("Delivered", { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(
    await page.getByRole("row").filter({ hasText: "In-app" }).count(),
    1
  )
  await screenshot("07-time-window-delivered")
  await page.goto(collectionUrl)
  await page
    .getByRole("link", { name: "Error burst in 5 minutes", exact: true })
    .waitFor()
  await page
    .getByRole("link", { name: rule.config.name, exact: true })
    .waitFor()
  await screenshot("07-alerts-list")
  await page.goto(
    `${collectionUrl}?filter=${encodeURIComponent("type = time_window")}`
  )
  await page
    .getByRole("link", { name: "Error burst in 5 minutes", exact: true })
    .waitFor()
  assert.equal(
    await page
      .getByRole("link", { name: rule.config.name, exact: true })
      .count(),
    0
  )
  await page.reload()
  await page
    .getByRole("link", { name: "Error burst in 5 minutes", exact: true })
    .waitFor()
  await page.goto(detailUrl)
  await page
    .getByRole("heading", { name: rule.config.name, exact: true })
    .waitFor()
  proof.timeWindow = {
    matchCount: burst.payload.matchCount,
    status: burst.status,
  }
  await page
    .getByRole("switch", {
      name: "Enable Production error webhook",
      exact: true,
    })
    .click()
  await until(
    async () =>
      (await alerts()).alerts.find((item) => item.id === rule.id)?.config
        .enabled === false
  )
  await ingest("Error while paused", "errored")
  await wait(1500)
  assert.equal(received.length, 2)
  // Older history uses real API pagination; seed explicit history fixtures only
  // after proving real ingestion/delivery above.
  await pool.query(
    `INSERT INTO alert_deliveries(id,project_id,alert_id,alert_name,action,payload,status,attempts)
    SELECT 'browser-history-'||n,$1,$2,'History fixture','in_app',jsonb_build_object('matchCount',n),'failed',5 FROM generate_series(1,60) n`,
    [projectId, rule.id]
  )
  await page.reload()
  await page.getByRole("button", { name: "Load more", exact: true }).waitFor()
  const olderResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/alerts/${rule.id}/notifications?`) &&
      response.url().includes("cursor=")
  )
  await page.getByRole("button", { name: "Load more", exact: true }).click()
  assert.equal((await (await olderResponse).json()).items.length, 11)
  await page
    .getByRole("button", { name: "Load more", exact: true })
    .waitFor({ state: "hidden" })
  await page.goto(
    `${detailUrl}?filter=${encodeURIComponent("status = delivered")}`
  )
  await page.getByText("Delivered", { exact: true }).waitFor()
  assert.equal(await page.getByText("Failed", { exact: true }).count(), 0)
  if ((await sidebarToggle.getAttribute("aria-expanded")) === "true")
    await sidebarToggle.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot("08-mobile-history")
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    ),
    false
  )
  await page.goto(collectionUrl)
  await page.getByRole("button", { name: "New alert", exact: true }).click()
  await page.getByText("Slow LLM calls", { exact: true }).click()
  await screenshot("08-mobile-template-dialog")
  assert.equal(
    await page
      .getByRole("button", { name: "Continue", exact: true })
      .isVisible(),
    true
  )
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.waitForURL(`${collectionUrl}/new?template=slow-llm`)
  await page.getByLabel("Name", { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Slow LLM calls"
  )
  await screenshot("09-mobile-editor")
  assert(
    await page
      .getByRole("button", { name: "Create alert", exact: true })
      .isVisible()
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    ),
    false
  )
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForURL(collectionUrl)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole("table").waitFor()

  // Presentation-only fault injection; actual alert operations above use real services.
  let releaseLoading!: () => void
  const loadingRead = new Promise<void>((resolve) => {
    releaseLoading = resolve
  })
  await page.route(
    `**${alertsPath}`,
    async (route) => {
      await loadingRead
      await route.continue()
    },
    { times: 1 }
  )
  try {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page
      .getByRole("status")
      .filter({ hasText: "Loading alerts" })
      .waitFor()
    await screenshot("10-loading")
  } finally {
    releaseLoading()
  }
  await page.getByRole("table").waitFor()
  await page.route(
    `**${alertsPath}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Temporary service failure" },
        }),
      }),
    { times: 1 }
  )
  await page.getByRole("button", { name: "Refresh" }).click()
  await page
    .getByRole("alert")
    .filter({ hasText: "Temporary service failure" })
    .waitFor()
  await screenshot("11-load-error")
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page
    .getByRole("alert")
    .filter({ hasText: "Temporary service failure" })
    .waitFor({ state: "hidden" })
  const unauthorized = await fetch(`${base}${alertsPath}`)
  assert.equal(unauthorized.status, 401)
  await page.getByRole("link", { name: rule.config.name, exact: true }).click()
  await page.waitForURL(detailUrl)
  await page.getByRole("button", { name: "Delete alert", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete alert", exact: true })
    .click()
  await page.waitForURL(collectionUrl)
  await until(
    async () => !(await alerts()).alerts.some((item) => item.id === rule.id)
  )
  await page.goto(detailUrl)
  await page
    .getByRole("alert")
    .filter({ hasText: "Alert not found." })
    .waitFor()
  assert.equal(
    await page.getByRole("link", { name: "Edit alert", exact: true }).count(),
    0
  )
  await screenshot("12-missing-alert")
  if (process.env.DATOOL_ALERT_E2E_PRODUCTION === "1") {
    // Automatic route prefetching only runs in production. Keep this check on
    // the same disposable fixture and use in-app delivery, without weakening
    // production webhook restrictions for the local receiver.
    await stop(worker)
    await stop(server)
    certificateDirectory = await mkdtemp(resolve(tmpdir(), "datool-alert-tls-"))
    const keyPath = resolve(certificateDirectory, "key.pem")
    const certificatePath = resolve(certificateDirectory, "cert.pem")
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ])
    productionProxy = createHttpsServer(
      { key: await readFile(keyPath), cert: await readFile(certificatePath) },
      (request, response) => {
        const upstream = proxyRequest(
          new URL(request.url ?? "/", base),
          {
            method: request.method,
            headers: {
              ...request.headers,
              "x-forwarded-proto": "https",
              "x-forwarded-host": request.headers.host,
            },
          },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers)
            result.pipe(response)
          }
        )
        upstream.on("error", () => {
          response.writeHead(502)
          response.end()
        })
        request.pipe(upstream)
      }
    )
    await new Promise<void>((resolve) =>
      productionProxy!.listen(0, "127.0.0.1", resolve)
    )
    const productionBase = `https://127.0.0.1:${(productionProxy.address() as { port: number }).port}`
    const productionCollection = `${productionBase}/p/alerts-e2e/alerts`
    const productionEnv: NodeJS.ProcessEnv = {
      ...env,
      NODE_ENV: "production",
      BETTER_AUTH_URL: productionBase,
      DATOOL_ALERT_LOCAL_WEBHOOKS: undefined,
    }
    console.log("Building production app for route navigation acceptance…")
    const build = start(
      ["run", "build"],
      "server",
      productionEnv
    )
    const buildCode = await new Promise<number | null>((resolve) =>
      build.once("exit", resolve)
    )
    assert.equal(
      buildCode,
      0,
      `Production build failed.\n${serverLog.slice(-8000)}`
    )
    start(
      [
        "run",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        new URL(base).port,
      ],
      "server",
      productionEnv
    )
    await until(async () => {
      try {
        return (await fetch(`${base}/sign-in`)).ok
      } catch {
        return false
      }
    })
    await context.addCookies([
      {
        name: `__Secure-${fixture.cookie.name}`,
        value: fixture.cookie.value,
        url: productionBase,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ])
    await page.goto(productionCollection)
    await page.getByRole("table").waitFor()
    if ((await sidebarToggle.getAttribute("aria-expanded")) !== "true")
      await sidebarToggle.click()
    await page
      .locator("aside")
      .getByRole("link", { name: "Traces", exact: true })
      .click()
    await page.waitForURL(`${productionBase}/p/alerts-e2e/traces`)
    await sidebarLink.hover()
    await sidebarLink.click()
    await page.waitForURL(productionCollection)
    await page.getByRole("table").waitFor()
    await page.getByRole("button", { name: "New alert", exact: true }).click()
    await page.getByText("Expensive requests", { exact: true }).click()
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await page.waitForURL(
      `${productionCollection}/new?template=expensive-requests`
    )
    await page
      .getByRole("button", { name: "Create alert", exact: true })
      .click()
    await page.waitForURL(/\/alerts\/[a-f0-9-]{36}$/)
    const productionDetail = page.url()
    await page.reload()
    await page
      .getByRole("heading", { name: "Expensive requests", exact: true })
      .waitFor()
    await page.getByRole("link", { name: "Edit alert", exact: true }).click()
    await page.waitForURL(`${productionDetail}/edit`)
    await page
      .getByLabel("Name", { exact: true })
      .fill("Production navigation proof")
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click()
    await page.waitForURL(productionDetail)
    await page
      .getByRole("heading", {
        name: "Production navigation proof",
        exact: true,
      })
      .waitFor()
    await sidebarLink.click()
    await page.waitForURL(productionCollection)
    await page
      .getByRole("link", { name: "Production navigation proof", exact: true })
      .waitFor()
    await screenshot("13-production-navigation")
    proof.productionNavigation = {
      build: "bun run build",
      runtime: "next start",
      transport: "local HTTPS proxy with a disposable self-signed certificate",
      sidebarTransitions: true,
      allFourRoutes: true,
      createEditReload: true,
    }
  }
  proof.ui = {
    create: true,
    reload: true,
    editDirtyRevert: true,
    editSaved: true,
    invalidFilter: true,
    routeNavigationAndCancel: true,
    templates: ["request-failures", "error-burst", "slow-llm"],
    templateDialog: true,
    emptyAlert: true,
    templatePrefillSurvivesReload: true,
    chooserDoesNotPersistAlert: true,
    sidebarAndLegacyRedirect: true,
    scopedHistoryPagination: true,
    shareableFilters: true,
    missingAlert: true,
    mobile: true,
    loading: true,
    loadErrorRetry: true,
    pause: true,
    delete: true,
    unauthenticatedStatus: 401,
  }
  assert.deepEqual(browserErrors, [])
  proof.browserErrors = browserErrors
  proof.completedAt = new Date().toISOString()
  proof.result = "PASS"
  await Promise.all(
    ["failure.txt", "failure.png", "failure-page.txt"].map((name) =>
      rm(resolve(output, name), { force: true })
    )
  )
  await writeFile(resolve(output, "proof.json"), JSON.stringify(proof, null, 2))
  console.log(`PASS browser alerts end-to-end. Evidence: ${output}`)
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0]
  if (failedPage) {
    await failedPage.screenshot({
      path: resolve(output, "failure.png"),
      fullPage: true,
    })
    await writeFile(
      resolve(output, "failure-page.txt"),
      await failedPage.locator("body").innerText()
    )
  }
  await writeFile(resolve(output, "failure.txt"), String(error))
  throw error
} finally {
  await browser?.close()
  productionProxy?.closeAllConnections()
  if (productionProxy)
    await new Promise<void>((resolve) =>
      productionProxy!.close(() => resolve())
    )
  if (certificateDirectory)
    await rm(certificateDirectory, { recursive: true, force: true })
  await Promise.all(children.map(stop))
  await new Promise<void>((done) => receiver.close(() => done()))
  await writeFile(resolve(output, "server.log"), serverLog)
  await writeFile(resolve(output, "worker.log"), workerLog)
  await writeFile("next-env.d.ts", originalNextEnv)
  await writeFile("tsconfig.json", originalTsconfig)
  await pool.end()
  await target.close()
  await reader?.close()
}

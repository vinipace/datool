/**
 * Disposable browser verification for organization/project slug sessions.
 *
 * This script owns its PostgreSQL container and random schema. It never reads
 * DATABASE_URL, and it leaves the app/container running when KEEP is set so a
 * human can inspect the exact fixture in a browser.
 *
 *   bun build scripts/verify-organization-session.ts --target node --packages external --outfile .tmp/verify-org-session.mjs
 *   KEEP_ORG_SESSION_E2E=1 node .tmp/verify-org-session.mjs
 */

import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer, request as requestHttp } from "node:http"
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { makeSignature } from "better-auth/crypto"
import { Pool } from "pg"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"

import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  type IsolatedPostgres,
} from "../tests/helpers/postgres"

const root = process.cwd()
const execute = promisify(execFile)
const id = randomUUID().slice(0, 8)
const container = `datool-org-session-${id}`
const secret = `disposable-organization-session-e2e-${id}-secret-1234567890`
const keep = process.env.KEEP_ORG_SESSION_E2E === "1"
const fixtureDirectory = await mkdtemp(
  join(tmpdir(), "datool-org-session-fixture-")
)
const storageStatePath = join(fixtureDirectory, "browser-storage-state.json")
const fixturePath = join(fixtureDirectory, "fixture.json")

let target: IsolatedPostgres | undefined
let pool: Pool | undefined
let app: ChildProcess | undefined
let proxy: HttpsServer | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined

type Fixture = {
  baseUrl: string
  databaseUrl: string
  cookieName: string
  cookieValue: string
  userId: string
  organizations: {
    alpha: { id: string; name: string; slug: string; projectId: string }
    beta: { id: string; name: string; slug: string; projectId: string }
    closed: { id: string; name: string; slug: string; projectId: string }
  }
}

const checks: string[] = []
function passed(description: string) {
  checks.push(description)
  console.info(`PASS ${description}`)
}

function availablePort() {
  const socket = createServer()
  return new Promise<number>((resolve, reject) => {
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      assert(address && typeof address !== "string")
      const port = address.port
      socket.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function docker(...args: string[]) {
  return (await execute("docker", args, { timeout: 120_000 })).stdout.trim()
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid!, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
}

async function seedFixture(baseUrl: string): Promise<Fixture> {
  await docker(
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=org-session-fixture",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine"
  )
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker(
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres"
      )
      break
    } catch {
      if (attempt === 59)
        throw new Error("Disposable PostgreSQL did not become ready")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const pgPort = (await docker("port", container, "5432/tcp")).split(":").at(-1)
  assert(pgPort)
  process.env.DATOOL_TEST_DATABASE_URL = `postgresql://postgres:org-session-fixture@127.0.0.1:${pgPort}/postgres`
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  process.env.DATABASE_URL = target.databaseUrl
  process.env.BETTER_AUTH_URL = baseUrl
  process.env.BETTER_AUTH_SECRET = secret
  Object.assign(process.env, { NODE_ENV: "development" })
  process.env.DATOOL_DATA_DIR = fixtureDirectory

  pool = new Pool({ connectionString: target.databaseUrl })
  const userId = randomUUID()
  const now = new Date()
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$4)`,
    [
      userId,
      "Organization Session Owner",
      `org-session-${id}@example.test`,
      now,
    ]
  )

  const organizations = {
    alpha: {
      id: randomUUID(),
      name: "Alpha organization",
      slug: `org-session-alpha-${id}`,
      projectId: randomUUID(),
    },
    beta: {
      id: randomUUID(),
      name: "Beta organization",
      slug: `org-session-beta-${id}`,
      projectId: randomUUID(),
    },
    closed: {
      id: randomUUID(),
      name: "Closed organization",
      slug: `org-session-closed-${id}`,
      projectId: randomUUID(),
    },
  }
  for (const [key, organization] of Object.entries(organizations)) {
    await pool.query(
      `INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$2,$3,$4)`,
      [organization.id, organization.name, organization.slug, now]
    )
    if (key !== "closed") {
      await pool.query(
        `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',$4)`,
        [randomUUID(), organization.id, userId, now]
      )
    }
    await pool.query(
      `INSERT INTO project (id,organization_id,name,slug,created_at,updated_at) VALUES ($1,$2,$3,'same-project',$4,$4)`,
      [
        organization.projectId,
        organization.id,
        `${organization.name} project`,
        now,
      ]
    )
    await pool.query(
      `INSERT INTO traces (id,project_id,name,operation,status,started_at,ended_at) VALUES ($1,$2,$3,'fixture','completed',$4,$4)`,
      [
        `${key}-session-trace`,
        organization.projectId,
        `${organization.name} trace`,
        now.toISOString(),
      ]
    )
    await pool.query(
      `INSERT INTO project (id,organization_id,name,slug,created_at,updated_at) VALUES ($1,$2,$3,'later-project',$4,$4)`,
      [randomUUID(), organization.id, `${organization.name} later project`, new Date(now.getTime() + 1_000)]
    )
  }

  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(userId)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  const cookieName = context.authCookies.sessionToken.name
  const cookieValue = encodeURIComponent(`${session.token}.${signature}`)
  return {
    baseUrl,
    databaseUrl: target.databaseUrl,
    cookieName,
    cookieValue,
    userId,
    organizations,
  }
}

async function launchApp(baseUrl: string) {
  console.info("Building the production app for browser verification…")
  const runtimeEnv = {
    ...process.env,
    NODE_ENV: "production" as const,
    NEXT_TELEMETRY_DISABLED: "1",
  }
  await execute(
    "node",
    [join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    {
      cwd: root,
      env: runtimeEnv,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  )
  passed("production build completes")
  const internalPort = await availablePort()
  const keyPath = join(fixtureDirectory, "localhost.key")
  const certPath = join(fixtureDirectory, "localhost.crt")
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ])
  proxy = createHttpsServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      const upstream = requestHttp(
        {
          hostname: "127.0.0.1",
          port: internalPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, "x-forwarded-proto": "https" },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers)
          incoming.pipe(response)
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
    proxy!.listen(Number(new URL(baseUrl).port), "127.0.0.1", resolve)
  )
  app = spawn(
    "node",
    [
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(internalPort),
    ],
    {
      cwd: root,
      detached: true,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let log = ""
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk) => (log = (log + chunk).slice(-30_000)))
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app.exitCode !== null)
      throw new Error(`Next exited before becoming ready:\n${log}`)
    try {
      const response = await fetch(
        `http://127.0.0.1:${internalPort}/api/auth/get-session`
      )
      if (response.status < 500) return
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Next did not become ready:\n${log}`)
}

async function writeFixture(fixture: Fixture) {
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
  await writeFile(
    storageStatePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: fixture.cookieName,
            value: fixture.cookieValue,
            url: fixture.baseUrl,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      null,
      2
    )}\n`
  )
}

async function expectPath(page: Page, path: string, label: string) {
  await page.waitForURL((url) => url.pathname === path, {
    timeout: 90_000,
    waitUntil: "load",
  })
  assert.equal(new URL(page.url()).pathname, path, label)
}

async function apiJson(
  page: Page,
  path: string,
  headers: Record<string, string> = {}
) {
  return page.evaluate(
    async ({ path, headers }) => {
      const response = await fetch(path, { headers })
      return { status: response.status, body: await response.json() }
    },
    { path, headers }
  )
}

async function sessionActiveOrganization(fixture: Fixture) {
  const result = await pool!.query<{ activeOrganizationId: string | null }>(
    `SELECT "activeOrganizationId" FROM session WHERE token = $1`,
    [decodeURIComponent(fixture.cookieValue).split(".")[0]]
  )
  return result.rows[0]?.activeOrganizationId ?? null
}

async function waitForActiveOrganization(
  fixture: Fixture,
  organizationId: string
) {
  const deadline = Date.now() + 15_000
  let active = await sessionActiveOrganization(fixture)
  while (active !== organizationId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    active = await sessionActiveOrganization(fixture)
  }
  assert.equal(active, organizationId)
}

async function runBrowserChecks(fixture: Fixture) {
  browser = await chromium.launch({
    headless: !keep && process.env.HEADED_ORG_SESSION_E2E !== "1",
  })
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: storageStatePath,
    viewport: { width: 1440, height: 960 },
  })
  context.setDefaultTimeout(60_000)
  context.setDefaultNavigationTimeout(120_000)
  const page = await context.newPage()
  page.on("request", (request) => {
    if (request.isNavigationRequest() || request.url().includes("/set-active"))
      console.info(
        `REQUEST ${request.method()} ${new URL(request.url()).pathname}`
      )
  })
  page.on("pageerror", (error) =>
    console.error(`browser pageerror: ${error.message}`)
  )
  page.on(
    "console",
    (message) =>
      message.type() === "error" &&
      console.error(`browser console error: ${message.text()}`)
  )
  const alpha = fixture.organizations.alpha
  const beta = fixture.organizations.beta
  const closed = fixture.organizations.closed
  const alphaProjectPath = "/p/same-project/traces"
  const betaProjectPath = "/p/same-project/traces"
  const betaProjectsPath = "/p/same-project/projects"

  for (const [legacy, canonical] of [
    ["/app", "/"],
    ["/app/projects", "/projects"],
    ["/app/api-keys", "/api-keys"],
    ["/app/settings/mcp", "/settings/mcp"],
    ["/app/p/same-project/traces?tag=one&tag=two", "/p/same-project/traces?tag=one&tag=two"],
    ["/app/p/project%20name/traces", "/p/project%20name/traces"],
  ]) {
    const response = await context.request.get(`${fixture.baseUrl}${legacy}`, { maxRedirects: 0 })
    assert.equal(response.status(), 307)
    const destination = new URL(response.headers().location, fixture.baseUrl)
    assert.equal(destination.origin, fixture.baseUrl)
    assert.equal(destination.pathname + destination.search, canonical)
  }
  passed("legacy /app redirects retain encoded paths and repeated query parameters")

  const signedOut = await browser.newContext({ ignoreHTTPSErrors: true })
  const signedOutPage = await signedOut.newPage()
  for (const path of [
    "/",
    "/p/same-project/traces/alpha-session-trace?span=span-1",
    "/projects",
    "/api-keys",
    "/settings/mcp",
    "/app/p/same-project/traces/alpha-session-trace?span=span-1",
  ]) {
    await signedOutPage.goto(`${fixture.baseUrl}${path}`)
    await signedOutPage.waitForURL((url) => url.pathname === "/sign-in")
    assert.equal(
      new URL(signedOutPage.url()).searchParams.get("callbackUrl"),
      path.replace(/^\/app(?=\/|$)/, "")
    )
  }
  await signedOut.close()
  passed("signed-out canonical deep links preserve their full sign-in callback")

  await page.goto(`${fixture.baseUrl}/`, { waitUntil: "load" })
  await page.getByRole("heading", { name: "Organizations" }).waitFor()
  await page.getByText(alpha.name, { exact: true }).waitFor()
  await page.getByText(beta.name, { exact: true }).waitFor()
  assert.equal(await page.getByText(closed.name, { exact: true }).count(), 0)
  assert.equal(new URL(page.url()).pathname, "/")
  passed("no-selection flow lists only member organizations at /")

  await page.goto(`${fixture.baseUrl}/organizations?returnTo=${encodeURIComponent(`${alphaProjectPath}?from=alias`)}`)
  await expectPath(page, "/", "organization selection alias should use the root route")
  assert.equal(new URL(page.url()).searchParams.get("returnTo"), `${alphaProjectPath}?from=alias`)
  passed("organization selection alias preserves the requested destination")

  await page.goto(`${fixture.baseUrl}${alphaProjectPath}?from=selection`)
  await expectPath(
    page,
    "/",
    "missing active organization should open the picker"
  )
  assert.equal(
    new URL(page.url()).searchParams.get("returnTo"),
    `${alphaProjectPath}?from=selection`
  )
  await page
    .getByRole("row", { name: `Open ${alpha.name}`, exact: true })
    .click()
  await expectPath(
    page,
    alphaProjectPath,
    "organization selection should resume the deep link"
  )
  assert.equal(new URL(page.url()).search, "?from=selection")
  passed("organization selection resumes the original canonical deep link")

  const selectAlpha = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: window.location.origin,
      },
      body: JSON.stringify({ organizationId }),
    })
    return { status: response.status, body: await response.text() }
  }, alpha.id)
  assert.equal(
    selectAlpha.status,
    200,
    `organization entry setup returned HTTP ${selectAlpha.status}: ${selectAlpha.body}`
  )
  assert.equal(await sessionActiveOrganization(fixture), alpha.id)
  passed(
    "active organization session is established before active project routes"
  )

  await page.goto(`${fixture.baseUrl}${alphaProjectPath}`, {
    waitUntil: "load",
  })
  try {
    await page.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
  } catch (error) {
    console.error(
      `alpha project page diagnostics: url=${page.url()} title=${await page.title()} body=${(await page.locator("body").innerText()).slice(0, 1200)}`
    )
    throw error
  }
  assert.equal(new URL(page.url()).pathname, alphaProjectPath)
  assert.equal(
    await page.getByText(`${alpha.name} project`, { exact: true }).count(),
    1
  )
  await page.getByText(`${alpha.name} trace`, { exact: true }).first().waitFor()
  passed("prefix-free project slug URL renders")

  await page.goto(`${fixture.baseUrl}/`)
  await expectPath(page, alphaProjectPath, "home should open the first project of the active organization")
  await page.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
  assert.equal(await sessionActiveOrganization(fixture), alpha.id)
  passed("home opens the oldest project in the active organization without changing the session")

  await page.goto(`${fixture.baseUrl}/organizations`)
  await expectPath(page, "/", "the explicit organization picker should remain accessible")
  await page.getByRole("heading", { name: "Organizations" }).waitFor()
  passed("explicit organization selection remains available with an active organization")

  await page.goto(`${fixture.baseUrl}/app${alphaProjectPath}?tag=one&tag=two#legacy`)
  await page.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
  assert.equal(new URL(page.url()).pathname, alphaProjectPath)
  assert.deepEqual(new URL(page.url()).searchParams.getAll("tag"), ["one", "two"])
  assert.equal(new URL(page.url()).hash, "#legacy")
  passed("authenticated legacy deep links retain their query and fragment")

  for (const child of ["traces", "sessions", "datasets", "evals", "reviews", "scorers", "dashboards", "playground", "projects", "settings", "settings/api-keys", "settings/mcp"]) {
    const response = await page.goto(`${fixture.baseUrl}/p/same-project/${child}`)
    assert.equal(response?.status(), 200, `${child} should render`)
    await page.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
    assert.equal(await page.locator('a[href="/app"], a[href^="/app/"]').count(), 0)
  }
  passed("all workspace collections and settings render with prefix-free navigation")
  for (const alias of ["/scorers", "/dashboards", "/playground"]) {
    await page.goto(`${fixture.baseUrl}${alias}`)
    await expectPath(page, alphaProjectPath, "unscoped aliases should return to the active workspace")
    await page.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
  }
  passed("unscoped resource aliases return to the active workspace")
  await page.goto(`${fixture.baseUrl}${alphaProjectPath}`)

  const betaFromAlpha = await apiJson(
    page,
    "/api/traces?projectId=" + encodeURIComponent(beta.projectId),
    {
      "x-project-id": beta.projectId,
    }
  )
  assert.equal(betaFromAlpha.status, 200)
  assert.equal(betaFromAlpha.body.data.items[0].id, "beta-session-trace")
  const alphaFromBeta = await apiJson(
    page,
    "/api/traces?projectId=" + encodeURIComponent(alpha.projectId),
    {
      "x-project-id": alpha.projectId,
    }
  )
  assert.equal(alphaFromBeta.status, 200)
  assert.equal(alphaFromBeta.body.data.items[0].id, "alpha-session-trace")
  const missingScope = await apiJson(page, "/api/traces")
  assert.equal(missingScope.status, 400)
  const mismatchedScope = await apiJson(
    page,
    `/api/traces?projectId=${alpha.projectId}`,
    { "x-project-id": beta.projectId }
  )
  assert.equal(mismatchedScope.status, 400)
  passed("tracer APIs require and honor explicit project scope")

  const resolvedTrace = await page.evaluate(async (projectId) => {
    const response = await fetch("/api/agent/resolve_trace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-id": projectId,
      },
      body: JSON.stringify({ key: "alpha-session-trace" }),
    })
    return { status: response.status, body: await response.json() }
  }, alpha.projectId)
  assert.equal(resolvedTrace.status, 200)
  assert.equal(
    resolvedTrace.body.data.path,
    "/p/same-project/traces/alpha-session-trace"
  )
  assert.equal(
    new URL(resolvedTrace.body.data.url).pathname,
    resolvedTrace.body.data.path
  )
  passed("resource links use canonical organization-free URLs")

  const pageB = await context.newPage()
  await pageB.goto(`${fixture.baseUrl}${alphaProjectPath}`, {
    waitUntil: "load",
  })
  await pageB.locator(`[data-project-id="${alpha.projectId}"]`).waitFor()
  await pageB
    .getByText(`${alpha.name} trace`, { exact: true })
    .first()
    .waitFor()
  let switcher = page.getByRole("button", { name: /Switch organization:/i })
  if ((await switcher.count()) === 0 || !(await switcher.first().isVisible())) {
    await page.getByRole("button", { name: /Toggle sidebar/i }).click()
    switcher = page.getByRole("button", { name: /Switch organization:/i })
  }
  try {
    await switcher.waitFor()
  } catch (error) {
    console.error(
      `switcher diagnostics: url=${page.url()} count=${await page.getByRole("button", { name: /Switch organization:/i }).count()} body=${(await page.locator("body").innerText()).slice(0, 1200)}`
    )
    throw error
  }
  await switcher.click()
  await page.getByRole("link", { name: beta.name, exact: true }).click()
  await expectPath(
    page,
    betaProjectsPath,
    "organization switcher should navigate to the selected organization"
  )
  await waitForActiveOrganization(fixture, beta.id)
  passed(
    "organization switcher updates the Better Auth active organization session"
  )

  await pageB.locator(`[data-project-id="${beta.projectId}"]`).waitFor()
  assert.equal(
    new URL(pageB.url()).pathname,
    betaProjectPath,
    "sibling tab should open the first project in the new active organization"
  )
  passed("organization selection synchronizes across tabs")

  await page.goto(`${fixture.baseUrl}/`)
  await expectPath(page, betaProjectPath, "home should follow the new active organization")
  await page.locator(`[data-project-id="${beta.projectId}"]`).waitFor()
  assert.equal(await sessionActiveOrganization(fixture), beta.id)
  passed("home follows the active organization after switching")

  await page.goto(`${fixture.baseUrl}/api-keys`, { waitUntil: "load" })
  await page
    .getByText(/API keys/i)
    .first()
    .waitFor()
  await page.goto(`${fixture.baseUrl}/settings/mcp`, { waitUntil: "load" })
  await page.getByText(/MCP/i).first().waitFor()
  passed("organization API-key and MCP settings routes render")

  await page.goto(`${fixture.baseUrl}${betaProjectPath}`, { waitUntil: "load" })
  await page.locator(`[data-project-id="${beta.projectId}"]`).waitFor()
  await page.reload({ waitUntil: "load" })
  await page.locator(`[data-project-id="${beta.projectId}"]`).waitFor()
  passed(
    "project slug deep link survives refresh and resolves the correct duplicate slug"
  )

  const activeBeforeRemovedRoutes = await sessionActiveOrganization(fixture)
  for (const path of [
    `/app/${alpha.slug}`,
    `/app/${alpha.slug}/api-keys`,
    `/app/${alpha.slug}/settings/mcp`,
    `/app/${alpha.slug}/p/same-project/traces?from=removed#trace`,
  ]) {
    const response = await page.goto(`${fixture.baseUrl}${path}`, {
      waitUntil: "load",
    })
    assert.equal(response?.status(), 404)
    await page.getByRole("heading", { name: "404", exact: true }).waitFor()
    assert.equal(await page.locator("[data-project-id]").count(), 0)
  }
  assert.equal(
    await sessionActiveOrganization(fixture),
    activeBeforeRemovedRoutes
  )
  passed(
    "removed organization-prefixed URLs return 404 without changing the active organization"
  )

  await page.goto(`${fixture.baseUrl}${betaProjectPath}`, { waitUntil: "load" })
  const deniedSelection = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    })
    return response.status
  }, closed.id)
  assert.equal(deniedSelection, 403)
  assert.equal(await sessionActiveOrganization(fixture), null)
  passed("inaccessible organization selection is denied")

  const selectBeta = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    })
    return { status: response.status, body: await response.text() }
  }, beta.id)
  assert.equal(
    selectBeta.status,
    200,
    `removed-membership setup returned HTTP ${selectBeta.status}: ${selectBeta.body}`
  )
  await page.goto(`${fixture.baseUrl}${betaProjectPath}`, { waitUntil: "load" })
  await page.locator(`[data-project-id="${beta.projectId}"]`).waitFor()
  await pool!.query(
    `DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
    [beta.id, fixture.userId]
  )
  const removedResponse = await page.goto(
    `${fixture.baseUrl}${betaProjectPath}`,
    { waitUntil: "load" }
  )
  assert(removedResponse)
  await expectPath(
    page,
    "/",
    "removed member must return to organization selection"
  )
  assert.equal(await page.locator("[data-project-id]").count(), 0)
  const removedApi = await apiJson(
    page,
    `/api/traces?projectId=${beta.projectId}`,
    { "x-project-id": beta.projectId }
  )
  assert([403, 404].includes(removedApi.status))
  passed("removed membership denies project page and explicit project API")
  await page.goto(`${fixture.baseUrl}/`)
  await page.getByRole("heading", { name: "Organizations" }).waitFor()
  assert.equal(new URL(page.url()).pathname, "/")
  passed("home shows the picker when active organization membership is no longer valid")
  await pool!.query(
    `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',NOW())`,
    [randomUUID(), beta.id, fixture.userId]
  )

  const emptyOrganizationId = randomUUID()
  await pool!.query(
    `INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Empty organization',$2,NOW())`,
    [emptyOrganizationId, `empty-${id}`]
  )
  await pool!.query(
    `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',NOW())`,
    [randomUUID(), emptyOrganizationId, fixture.userId]
  )
  const selectEmpty = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    })
    return response.status
  }, emptyOrganizationId)
  assert.equal(selectEmpty, 200)
  await page.goto(`${fixture.baseUrl}/`)
  await expectPath(page, "/projects", "an empty active organization should open project setup")
  await page.getByRole("heading", { name: "Create your first project" }).waitFor()
  await page.getByRole("link", { name: "Back to organizations" }).click()
  await page.getByRole("heading", { name: "Organizations" }).waitFor()
  passed("an empty active organization opens project setup and can return to the picker")
  const restoreAlpha = await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    })
    return response.status
  }, alpha.id)
  assert.equal(restoreAlpha, 200)

  if (keep) {
    await page.goto(`${fixture.baseUrl}${alphaProjectPath}`, {
      waitUntil: "load",
    })
    await page
      .getByText(`${alpha.name} trace`, { exact: true })
      .first()
      .waitFor()
    await page.screenshot({
      path: join(fixtureDirectory, "final.png"),
      fullPage: true,
    })
  } else {
    await page.close()
    await pageB.close()
  }
}

const port = await availablePort()
const baseUrl = `https://127.0.0.1:${port}`
let fixture: Fixture | undefined
let completed = false
try {
  fixture = await seedFixture(baseUrl)
  await writeFixture(fixture)
  await launchApp(baseUrl)
  await runBrowserChecks(fixture)
  completed = true
  console.info(
    `\nOrganization session browser verification passed (${checks.length} checks).`
  )
  console.info(`Launch URL: ${baseUrl}/`)
  console.info(`Fixture JSON: ${fixturePath}`)
  console.info(`Browser storage state: ${storageStatePath}`)
  if (keep) {
    console.info(
      "KEEP_ORG_SESSION_E2E=1: app, browser and PostgreSQL remain running for inspection."
    )
    await new Promise<void>(() => {})
  }
} finally {
  if (!keep || !completed) {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    proxy?.closeAllConnections()
    proxy?.close()
    await stopProcess(app)
    await pool?.end().catch(() => undefined)
    await target?.close().catch(() => undefined)
    await docker("rm", "-f", container).catch(() => undefined)
  }
}

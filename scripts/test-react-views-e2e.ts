/** Authenticated browser -> real Next API -> disposable PostgreSQL. No API mocks. */
import assert from "node:assert/strict"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"
import { Pool } from "pg"
import { verifyReactPageViews } from "../tests/helpers/react-page-views-browser-proof"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "../tests/helpers/postgres"
const target = await createIsolatedPostgres()
const pool = new Pool({ connectionString: target.databaseUrl })
const output = resolve("artifacts/react-views-e2e")
await mkdir(output, { recursive: true })
const base = "http://127.0.0.1:3063"
const projectId = crypto.randomUUID()
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: target.databaseUrl,
  DATOOL_BILLING_ENABLED: "false",
  BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: "local-react-views-browser-proof-secret-32-characters",
  DATOOL_PROJECT_ID: projectId,
  DATOOL_DIST_DIR: ".next-react-views-e2e",
  NEXT_TELEMETRY_DISABLED: "1",
}
const originals = await Promise.all(
  ["tsconfig.json", "next-env.d.ts"].map(
    async (path) => [path, await readFile(path, "utf8")] as const
  )
)
let server: ChildProcess | undefined,
  browser: Browser | undefined,
  lastPage: Page | undefined,
  log = ""
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment:
    "Real local Next app, PostgreSQL, authenticated owner and teammate in independent browser contexts",
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function start() {
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
      "3063",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  )
  for (const stream of [server.stdout, server.stderr])
    stream?.on("data", (chunk) => {
      log += String(chunk)
    })
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`Server exited: ${log.slice(-3000)}`)
    try {
      if (
        (await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(20000) }))
          .ok
      )
        return
    } catch {
      /* starting */
    }
    await wait(500)
  }
  throw new Error(`Server startup timed out: ${log.slice(-3000)}`)
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  server.kill("SIGTERM")
  const timer = setTimeout(() => server?.kill("SIGKILL"), 10000)
  await new Promise<void>((done) => server!.once("exit", () => done()))
  clearTimeout(timer)
}
async function openTrace(page: Page, id: string) {
  await page.goto(`${base}/p/views-e2e/traces/${id}`)
  await page.getByRole("button", { name: "Views", exact: true }).click()
  await page
    .getByRole("combobox", { name: "View", exact: true })
    .waitFor()
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[aria-label="View"]')
        ?.hasAttribute("disabled")
  )
}
async function select(page: Page, name: string) {
  await page.getByRole("combobox", { name: "View", exact: true }).click()
  await page.getByRole("option").filter({ hasText: name }).click()
}
async function code(page: Page, text: string) {
  const editor = page.getByRole("textbox", { name: "View code", exact: true })
  await editor.focus()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.insertText(text)
}
async function request(
  context: BrowserContext,
  method: string,
  path: string,
  data?: unknown,
  scope = projectId
) {
  return context.request.fetch(`${base}${path}`, {
    method,
    headers: { "x-project-id": scope, origin: base },
    ...(data === undefined ? {} : { data }),
  })
}
const viewCode =
  'import * as React from "react"; import { Card, Button } from "@datool/ui"; export default function View({trace}: ViewProps) { const [count,setCount] = React.useState(0); return <Card className="p-4"><h1>{trace.output.answer}</h1><Button onClick={() => setCount(n => n + 1)}>Clicks {count}</Button><p>{trace.spans ? "Full payload" : "Summary payload"}</p></Card> }'
try {
  await migrateIsolatedPostgres(target)
  const seeded = await promisify(execFile)(
    process.execPath,
    ["run", "tests/helpers/react-views-browser-fixture.ts"],
    { env }
  )
  const fixture = JSON.parse(seeded.stdout.trim())
  await pool.query(
    "UPDATE traces SET status='running', ended_at=null WHERE id='view-source'"
  )
  await start()
  browser = await chromium.launch({ headless: true })
  const owner = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
  })
  await owner.addInitScript(() => {
    const tools: Record<
      string,
      { name: string; execute: (input: unknown) => Promise<unknown> }
    > = {}
    Object.defineProperty(window, "__viewTools", { value: tools })
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool(tool: {
          name: string
          execute: (input: unknown) => Promise<unknown>
        }) {
          tools[tool.name] = tool
        },
        unregisterTool(name: string) {
          delete tools[name]
        },
      },
    })
  })
  await owner.addCookies([{ ...fixture.owner, url: base }])
  let page = await owner.newPage()
  lastPage = page
  page.setDefaultTimeout(45000)
  page.setDefaultNavigationTimeout(120000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pageTeammate = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" })
  await pageTeammate.addCookies([{ ...fixture.member, url: base }])
  proof.reactPageViews = await verifyReactPageViews({ page, owner, teammate: pageTeammate, base, projectId, output })
  await pageTeammate.close()
  console.log("PASS React Page View editor, persistence, sandbox navigation and selected Object View")
  await openTrace(page, "view-source")
  await page
    .getByText("Create a view from the view menu to get started.")
    .waitFor()
  await page.screenshot({ path: resolve(output, "empty.png") })
  await page
    .getByRole("button", { name: "Create new view", exact: true })
    .click()
  await page.getByLabel("View name", { exact: true }).fill("Answer card")
  await code(page, viewCode)
  assert.equal(
    await page.getByText("Data requirements", { exact: false }).count(),
    0
  )
  assert.equal(await page.getByLabel("Description", { exact: true }).count(), 0)
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click()
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Hello from source" })
    .waitFor()
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("combobox", { name: "View", exact: true }).waitFor()
  const response = await request(owner, "GET", "/api/react-views")
  assert.equal(response.status(), 200)
  let saved = (await response.json()).data.items[0]
  assert.equal(saved.origin.operation, "answer")
  assert.equal(saved.origin.group.version, "v1")
  assert.equal(saved.author.name, "Author")
  assert.equal(saved.requirements, null)
  assert.equal(saved.dataMode, "summary")
  const suggested = await request(owner, "POST", "/api/react-views/suggest", {
    code: viewCode,
    sample: { output: { answer: "Hello" } },
  })
  assert.equal(suggested.status(), 200)
  const requirements = (await suggested.json()).data.requirements
  assert.equal(requirements[0].path, "/output/answer")
  const configured = await request(
    owner,
    "PATCH",
    `/api/react-views/${saved.id}`,
    {
      dataMode: saved.dataMode,
      name: saved.name,
      description: saved.description,
      code: viewCode,
      requirements,
      expectedRevision: saved.revision,
    }
  )
  assert.equal(configured.status(), 200)
  saved = (await configured.json()).data
  proof.uiRequirementsUnknownAndApiConfiguration = true
  const persisted = await pool.query(
    "SELECT code, author, origin FROM react_views WHERE id=$1 AND project_id=$2",
    [saved.id, projectId]
  )
  assert.equal(persisted.rows[0].code, viewCode)
  proof.uiCreateAndDatabasePersistence = true
  console.log("PASS browser create and database persistence")
  assert.equal(
    await page.getByText("View details", { exact: false }).count(),
    0
  )
  assert.equal(
    await page.getByText("Rendered for this record", { exact: true }).count(),
    0
  )
  const previewFrame = page.frameLocator('iframe[title="React view preview"]')
  await previewFrame.getByText("Summary payload", { exact: true }).waitFor()
  await previewFrame.getByRole("button", { name: "Clicks 0" }).click()
  await pool.query("UPDATE traces SET output_json=$1 WHERE id='view-source'", [
    JSON.stringify({ answer: "Updated source answer" }),
  ])
  await previewFrame
    .getByRole("heading", { name: "Updated source answer" })
    .waitFor()
  await previewFrame.getByRole("button", { name: "Clicks 1" }).waitFor()
  proof.compiledComponentsAndLiveStateRetention = true
  await page.screenshot({ path: resolve(output, "trace-desktop.png") })
  await openTrace(page, "view-other")
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Hello from another trace" })
    .waitFor()
  proof.crossOperationReuse = true
  const teammate = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  })
  await teammate.addCookies([{ ...fixture.member, url: base }])
  let second = await teammate.newPage()
  second.setDefaultTimeout(45000)
  second.setDefaultNavigationTimeout(120000)
  await openTrace(second, "view-other")
  assert.equal(
    await second.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        key.startsWith("datool:project-react-view:")
      )
    ),
    false
  )
  await select(second, "Answer card")
  await second
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Hello from another trace" })
    .waitFor()
  proof.teammateFreshBrowser = true
  // Confirm project authorization, source scope, validation, pagination and read permissions over HTTP.
  assert.equal(
    (
      await request(
        owner,
        "GET",
        `/api/react-views/${saved.id}`,
        undefined,
        fixture.otherProjectId
      )
    ).status(),
    404
  )
  assert.equal(
    (
      await request(
        owner,
        "PATCH",
        `/api/react-views/${saved.id}`,
        {
          dataMode: saved.dataMode,
          name: saved.name,
          description: saved.description,
          code: viewCode,
          requirements: saved.requirements,
          expectedRevision: 1,
        },
        fixture.otherProjectId
      )
    ).status(),
    404
  )
  assert.equal(
    (
      await request(
        owner,
        "DELETE",
        `/api/react-views/${saved.id}?expectedRevision=1`,
        undefined,
        fixture.otherProjectId
      )
    ).status(),
    404
  )
  assert.deepEqual(
    (
      await (
        await request(
          owner,
          "GET",
          "/api/react-views",
          undefined,
          fixture.otherProjectId
        )
      ).json()
    ).data.items,
    []
  )
  const generic = {
    name: "Generic view",
    dataMode: "summary",
    description: "",
    code: 'import * as React from "react"; import { LineChart, Line, XAxis } from "@datool/charts"; export default () => <LineChart width={300} height={150} data={[{name:"A",value:1},{name:"B",value:2}]}><Line dataKey="value" isAnimationActive={false}/><XAxis dataKey="name"/></LineChart>',
    requirements: [],
    source: null,
  }
  assert.equal(
    (
      await request(
        owner,
        "POST",
        "/api/react-views",
        { ...generic, source: { kind: "trace", id: "view-source" } },
        fixture.otherProjectId
      )
    ).status(),
    404
  )
  assert.equal(
    (
      await request(owner, "POST", "/api/react-views", { ...generic, name: "" })
    ).status(),
    400
  )
  assert.equal(
    (await request(owner, "GET", "/api/react-views?limit=0")).status(),
    400
  )
  const readonly = await fetch(`${base}/api/react-views`, {
    headers: {
      authorization: `Bearer ${fixture.readKey}`,
      "x-project-id": projectId,
    },
  })
  assert.equal(readonly.status, 200)
  assert.equal(
    (
      await fetch(`${base}/api/react-views`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.readKey}`,
          "x-project-id": projectId,
          "content-type": "application/json",
        },
        body: JSON.stringify(generic),
      })
    ).status,
    403
  )
  assert.equal(
    (
      await fetch(`${base}/api/react-views`, {
        headers: { "x-project-id": projectId },
      })
    ).status,
    401
  )
  assert.equal(
    (
      await owner.request.post(`${base}/api/react-views`, {
        headers: {
          "x-project-id": projectId,
          origin: "https://untrusted.example",
        },
        data: generic,
      })
    ).status(),
    403
  )
  proof.projectIsolationAndPermissions = true
  // Execute the real app-registered WebMCP handlers against the authenticated API.
  const agentResult = await page.evaluate(
    async ({ code, selected }) => {
      const tools = (
        window as unknown as {
          __viewTools: Record<
            string,
            {
              execute(
                input: unknown
              ): Promise<{ isError?: boolean; content: { text: string }[] }>
            }
          >
        }
      ).__viewTools
      const created = await tools.create_trace_view.execute({
        name: "Agent view",
        description: "",
        code,
        dataMode: "summary",
        requirements: null,
        source: null,
      })
      if (created.isError) throw new Error(created.content[0].text)
      const view = JSON.parse(created.content[0].text)
      const updated = await tools.update_trace_view.execute({
        id: view.id,
        expectedRevision: view.revision,
        name: "Agent renamed view",
      })
      if (updated.isError) throw new Error(updated.content[0].text)
      const renamed = JSON.parse(updated.content[0].text)
      const invalid = await tools.update_trace_view.execute({
        id: view.id,
        expectedRevision: renamed.revision,
        code: 'import x from "unsupported-module"; export default x',
      })
      const deleted = await tools.delete_trace_view.execute({
        id: view.id,
        expectedRevision: renamed.revision,
      })
      const restored = await tools.select_trace_view.execute({ id: selected })
      return {
        mode: renamed.dataMode,
        invalid: invalid.isError,
        deleted: !deleted.isError,
        restored: !restored.isError,
      }
    },
    { code: viewCode, selected: saved.id }
  )
  assert.deepEqual(agentResult, {
    mode: "summary",
    invalid: true,
    deleted: true,
    restored: true,
  })
  proof.webMcpCompilationAndProjectPersistence = true
  const genericView = (
    await (await request(owner, "POST", "/api/react-views", generic)).json()
  ).data
  const unknownView = (
    await (
      await request(owner, "POST", "/api/react-views", {
        ...generic,
        name: "Unknown view",
        requirements: null,
      })
    ).json()
  ).data
  const firstPage = (
    await (await request(owner, "GET", "/api/react-views?limit=1")).json()
  ).data
  assert(firstPage.nextCursor)
  assert.equal(firstPage.items.length, 1)
  assert.equal(
    (
      await (
        await request(
          owner,
          "GET",
          `/api/react-views?limit=1&cursor=${firstPage.nextCursor}`
        )
      ).json()
    ).data.items.length,
    1
  )
  await openTrace(page, "view-mismatch")
  await page.getByRole("combobox", { name: "View", exact: true }).click()
  const options = page.getByRole("option")
  await options.first().waitFor()
  assert.deepEqual(await options.allTextContents(), [
    "Generic view",
    "Unknown view",
    "Answer card",
  ])
  const triggerBox = await page
    .getByRole("combobox", { name: "View", exact: true })
    .boundingBox()
  const popupBox = await page
    .locator('[data-slot="combobox-content"]')
    .boundingBox()
  assert(triggerBox && popupBox && Math.abs(triggerBox.x - popupBox.x) < 2)
  assert.equal(
    await page
      .getByPlaceholder("Search project views…")
      .locator("..")
      .locator("svg")
      .count(),
    1
  )
  proof.pickerNamesSearchAndAlignment = true
  await options.nth(0).click()
  await page
    .frameLocator('iframe[title="React view preview"]')
    .locator(".recharts-wrapper svg")
    .waitFor()
  proof.lazyChartsBundle = true
  await select(page, "Answer card")
  await page
    .getByRole("combobox", { name: "View", exact: true })
    .waitFor()
  proof.compatibilityOrderingAndSelectableMismatch = true
  // Dataset uses expected output and the exact same saved renderer.
  await page.goto(`${base}/p/views-e2e/datasets/view-dataset`)
  await page
    .getByRole("row", { name: "Open dataset row 1", exact: true })
    .click()
  await page.getByRole("button", { name: "Views", exact: true }).click()
  // Object View preferences are scoped to the page and object kind.
  await select(page, "Answer card")
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Expected dataset answer" })
    .waitFor()
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit view", exact: true }).click()
  await page.getByLabel("View name", { exact: true }).fill("Dataset answer")
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page
    .getByRole("menuitem", { name: "Save as new view", exact: true })
    .click()
  await page.getByRole("combobox", { name: "View", exact: true }).waitFor()
  const datasetView = (
    await (await request(owner, "GET", "/api/react-views")).json()
  ).data.items.find((view: { name: string }) => view.name === "Dataset answer")
  assert.equal(datasetView.origin.source.kind, "dataset-item")
  assert.equal(datasetView.origin.datasetId, "view-dataset")
  assert.deepEqual(datasetView.requirements, saved.requirements)
  await page.screenshot({ path: resolve(output, "dataset-desktop.png") })
  proof.datasetReuseAndCreation = true
  console.log(
    "PASS project isolation, compatibility ordering, fresh teammate, dataset reuse"
  )
  // Stale editor keeps its draft and offers a copy instead of silently overwriting.
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit view", exact: true }).click()
  await page.getByLabel("View name", { exact: true }).fill("My preserved draft")
  const updated = {
    name: "Dataset answer",
    dataMode: saved.dataMode,
    description: "Teammate update",
    code: viewCode,
    requirements: saved.requirements,
    expectedRevision: 1,
  }
  assert.equal(
    (
      await request(
        teammate,
        "PATCH",
        `/api/react-views/${datasetView.id}`,
        updated
      )
    ).status(),
    200
  )
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page
    .getByText("This view changed in another browser.", { exact: false })
    .waitFor()
  assert.equal(
    await page.getByLabel("View name", { exact: true }).inputValue(),
    "My preserved draft"
  )
  await page.getByLabel("View name", { exact: true }).fill("Recovered draft")
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page
    .getByRole("menuitem", { name: "Save as new view", exact: true })
    .click()
  await page.getByRole("combobox", { name: "View", exact: true }).waitFor()
  proof.concurrentEditRecovery = true
  console.log("PASS stale editor draft recovery")
  // Runtime errors are explicit and recover by selecting another view.
  const broken = (
    await (
      await request(owner, "POST", "/api/react-views", {
        ...generic,
        name: "Broken view",
        code: 'export default function View() { throw new Error("Preview test failure") }',
      })
    ).json()
  ).data
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Refresh", exact: true }).click()
  await select(page, "Broken view")
  await page.getByText("Error: Preview test failure", { exact: true }).waitFor()
  await select(page, "Dataset answer")
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Expected dataset answer" })
    .waitFor()
  proof.renderErrorAndRecovery = true
  await openTrace(page, "view-other")
  await select(page, "Dataset answer")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("combobox", { name: "View", exact: true }).click()
  await page.screenshot({ path: resolve(output, "mobile-picker.png") })
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit view", exact: true }).click()
  await page.getByRole("textbox", { name: "View code", exact: true }).waitFor()
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page
    .getByRole("menuitemradio", {
      name: "Complete trace with spans and scores",
    })
    .click()
  assert.equal(
    await page.getByLabel("View name", { exact: true }).inputValue(),
    "Dataset answer"
  )
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click()
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByText("Full payload", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit code", exact: true }).click()
  await page.getByRole("textbox", { name: "View code", exact: true }).waitFor()
  proof.dataModeChangePreservesDraft = true
  await page.getByLabel("View name", { exact: true }).focus()
  await page.screenshot({ path: resolve(output, "mobile-editor-focus.png") })
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  )
  await code(page, `${viewCode}\n// Revised in the UI`)
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("combobox", { name: "View", exact: true }).waitFor()
  assert.equal(
    (
      await (
        await request(owner, "GET", `/api/react-views/${datasetView.id}`)
      ).json()
    ).data.requirements,
    null
  )
  assert.equal(
    (
      await (
        await request(owner, "GET", `/api/react-views/${datasetView.id}`)
      ).json()
    ).data.dataMode,
    "full"
  )
  proof.uiCodeChangesResetRequirements = true
  proof.narrowMobileAndKeyboard = true
  console.log(
    "PASS render recovery, mobile layout, and UI requirement behavior"
  )
  // Close dev pages before restart so HMR cannot race our persistence navigation.
  await page.close()
  await second.close()
  await stop()
  console.log("Restarting the app to verify database persistence")
  await start()
  second = await teammate.newPage()
  second.setDefaultTimeout(45000)
  second.setDefaultNavigationTimeout(120000)
  lastPage = second
  await openTrace(second, "view-other")
  await second
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Hello from another trace" })
    .waitFor()
  proof.serverRestartPersistence = true
  assert.equal(
    (
      await request(
        owner,
        "DELETE",
        `/api/react-views/${datasetView.id}?expectedRevision=1`
      )
    ).status(),
    409
  )
  for (const view of [genericView, unknownView, broken])
    assert.equal(
      (
        await request(
          owner,
          "DELETE",
          `/api/react-views/${view.id}?expectedRevision=1`
        )
      ).status(),
      200
    )
  page = await owner.newPage()
  page.setDefaultTimeout(45000)
  page.setDefaultNavigationTimeout(120000)
  page.on("pageerror", (error) => errors.push(error.message))
  lastPage = page
  await openTrace(page, "view-other")
  await page
    .frameLocator('iframe[title="React view preview"]')
    .getByRole("heading", { name: "Hello from another trace" })
    .waitFor()
  await page.getByRole("button", { name: "View actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete view", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete view", exact: true })
    .click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  assert.equal(
    (
      await request(owner, "GET", `/api/react-views/${datasetView.id}`)
    ).status(),
    404
  )
  proof.deleteAndRevisionChecks = true
  proof.browserErrors = errors
  assert.equal(errors.length, 0, errors.join("\n"))
  proof.completedAt = new Date().toISOString()
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  proof.error = String(error)
  await lastPage
    ?.screenshot({ path: resolve(output, "failure.png") })
    .catch(() => {})
  throw error
} finally {
  await writeFile(resolve(output, "proof.json"), JSON.stringify(proof, null, 2))
  await writeFile(resolve(output, "server.log"), log)
  await browser?.close()
  await stop()
  await pool.end()
  await target.close()
  await Promise.all(
    originals.map(([path, content]) => writeFile(path, content))
  )
}

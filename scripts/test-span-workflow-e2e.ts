import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { chromium } from "playwright"
import { makeSignature } from "better-auth/crypto"
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

const root = process.cwd()
const output = join(root, "artifacts/span-workflow-e2e")
const directory = await mkdtemp(join(tmpdir(), "datool-span-workflow-"))
const appDirectory = join(directory, "app")
const target = await createIsolatedPostgres()
const base = "http://127.0.0.1:3117"
let next: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let pools: typeof import("../lib/db") | undefined
let serverLog = ""
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const checks: string[] = []
const pass = (message: string) => {
  checks.push(message)
  console.info(`PASS ${message}`)
}
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    PAYLOAD_DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "disposable-span-workflow-secret-1234567890",
    PAYLOAD_SECRET: "disposable-span-workflow-secret-1234567890",
    NODE_ENV: "development",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    NEXT_TELEMETRY_DISABLED: "1",
  })
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const credential = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Span workflow E2E",
      permissions: permissionStatements(workspaceScopes),
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
  await mkdir(appDirectory)
  for (const path of [
    "app",
    "components",
    "lib",
    "src",
    "cms",
    "content",
    "payload-migrations",
    "payload.config.ts",
    "payload-types.ts",
    "source.config.ts",
    "package.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
    "postcss.config.mjs",
    ".source",
  ]) {
    await cp(join(root, path), join(appDirectory, path), { recursive: true })
  }
  await symlink(
    join(root, "node_modules"),
    join(appDirectory, "node_modules"),
    "dir"
  )
  await symlink(join(root, "public"), join(appDirectory, "public"), "dir")
  next = spawn(
    "node",
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3117",
    ],
    {
      cwd: appDirectory,
      env: { ...process.env, DATOOL_DIST_DIR: ".next" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  for (const stream of [next.stdout, next.stderr])
    stream!.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-50000)
    })
  async function api(path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.key}`,
        "x-project-id": target.projectId,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    })
    const result = await response.json()
    assert(response.ok, JSON.stringify(result))
    return result.data
  }
  for (let i = 0; i < 120; i++) {
    try {
      await api("/api/agent/describe_agent_operations", {})
      break
    } catch {
      if (next.exitCode !== null || i === 119) throw new Error(serverLog)
      await pause(500)
    }
  }
  pass("real Next server and project-scoped API on isolated PostgreSQL")
  const ds = await api("/api/agent/create_dataset", {
    name: "Span calibration",
  })
  const trace = await api("/api/traces", {
    name: "Production extraction batch",
    input: null,
    output: null,
    status: "completed",
  })
  const span = await api(`/api/traces/${trace.id}/spans`, {
    name: "Brand extraction",
    kind: "agent",
    input: { messages: [{ role: "user", content: "Acme sells shoes." }] },
    output: { brands: ["Acme"] },
    status: "completed",
    startedAt: "2026-09-18T12:00:00.000Z",
    endedAt: "2026-09-18T12:00:01.000Z",
    attributes: {
      "prompt.version": "synthetic-v1",
      "gen_ai.response.model": "fixture-extractor",
    },
  })
  await api(`/api/traces/${trace.id}/spans`, {
    name: "Unrelated extraction",
    kind: "agent",
    input: "unrelated",
    output: "exclude",
    status: "completed",
    endedAt: "2026-09-18T12:00:01.000Z",
  })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  })
  await page
    .context()
    .addCookies([
      {
        name: context.authCookies.sessionToken.name,
        value: encodeURIComponent(`${session.token}.${signature}`),
        url: base,
      },
    ])
  await page.goto(`${base}/p/test-project/traces/${trace.id}?span=${span.id}`)
  await page
    .getByRole("button", { name: "Create dataset case" })
    .click({ timeout: 90000 })
  const dialog = page.getByRole("dialog", { name: "Create case from span" })
  await dialog.getByRole("combobox", { name: "Dataset" }).click()
  await page.getByRole("option", { name: "Span calibration" }).click()
  await dialog
    .getByRole("checkbox", { name: "Map input to app variables" })
    .check()
  await dialog
    .getByRole("textbox", { name: "Mapped app input JSON" })
    .fill('{"response":"Acme sells shoes."}')
  await dialog.getByRole("button", { name: "Preview case" }).click()
  await dialog.getByRole("button", { name: "Save case" }).waitFor()
  assert((await dialog.textContent())?.includes("Observed output (unreviewed)"))
  assert.equal((await api(`/api/datasets/${ds.id}`)).itemCount, 0)
  await mkdir(output, { recursive: true })
  await page.screenshot({
    path: join(output, "promotion-preview.png"),
    fullPage: true,
  })
  await dialog.getByRole("button", { name: "Save case" }).click()
  await dialog.getByRole("link", { name: "Open dataset" }).waitFor()
  const dataset = await api(`/api/datasets/${ds.id}`)
  assert.equal(dataset.items[0].sourceSpanId, span.id)
  assert.equal(dataset.items[0].expectedOutput, null)
  assert.deepEqual(dataset.items[0].input, { response: "Acme sells shoes." })
  assert.deepEqual(dataset.items[0].sourceSpanEvidence.input, span.input)
  assert.equal(dataset.items[0].sourceSpanEvidence.spans.length, 1)
  pass(
    "browser span selection → mapped case preview → save; source provenance, null reference and sibling exclusion persisted"
  )
  await dialog.getByRole("link", { name: "Open dataset" }).click()
  await page.waitForURL(`**/datasets/${ds.id}`)
  await page.screenshot({ path: join(output, "dataset.png"), fullPage: true })
  const snapshot = await api("/api/agent/create_dataset_snapshot", {
    datasetId: ds.id,
    label: "e2e-frozen",
  })
  const scorer = await api("/api/agent/create_scorer", {
    scorer: {
      ...defaultScorer,
      name: "Grounded synthetic extraction",
      slug: "grounded-synthetic",
      type: "javascript",
      threshold: 0.5,
      code: 'function evaluate({ trace }) { return { score: trace.output.brands[0] === "Acme" && trace.spans.length === 1 ? 1 : 0 }; }',
    },
  })
  const checked = await api("/api/agent/check_scorer_runtime", {
    scorerIds: [scorer.id],
  })
  assert.equal(checked.checks[0].execution, "not_checked")
  const probe = await api("/api/agent/probe_scorer_runtime", {
    scorerIds: [scorer.id],
    traceId: trace.id,
    spanId: span.id,
  })
  assert.equal(probe.checks[0].execution, "succeeded")
  assert.equal((await api("/api/agent/list_eval_runs", {})).items.length, 0)
  pass(
    "configuration diagnostics and actual sandbox probe stay distinct from saved evaluations"
  )
  const version = (
    await api("/api/agent/list_scorer_versions", { id: scorer.id })
  ).items[0]
  const request = {
    name: "Visible span calibration",
    datasetId: ds.id,
    datasetVersionId: snapshot.id,
    evaluatorIds: [scorer.id],
    evaluatorVersionIds: { [scorer.id]: version.id },
    requestKey: "span-e2e-run",
  }
  const run = await api("/api/agent/start_eval_run", request)
  assert(run.url.includes(`/evals/${run.id}`))
  assert.equal((await api("/api/agent/start_eval_run", request)).url, run.url)
  let finished = run
  for (let i = 0; i < 200 && finished.status === "running"; i++) {
    await pause(100)
    finished = await api("/api/agent/get_eval_run", { id: run.id })
  }
  assert.equal(finished.status, "completed")
  assert.equal(finished.results[0].score, 1)
  assert.equal(finished.results[0].definition.id, version.id)
  await page.goto(run.url)
  await page
    .getByText("Visible span calibration", { exact: true })
    .first()
    .waitFor({ timeout: 60000 })
  await page.screenshot({
    path: join(output, "saved-evaluation.png"),
    fullPage: true,
  })
  await page.reload()
  await page
    .getByText("Visible span calibration", { exact: true })
    .first()
    .waitFor()
  pass(
    "named saved evaluation returns a stable URL, runs pinned JavaScript scorer and survives browser reload"
  )
  // Exercise narrow layout, focus, Escape and failed/empty collection states in the same real UI.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/p/test-project/traces/${trace.id}?span=${span.id}`)
  await page.getByRole("button", { name: "Create dataset case" }).click()
  await page.getByRole("combobox", { name: "Dataset" }).waitFor()
  await page.screenshot({
    path: join(output, "promotion-mobile-loading.png"),
    fullPage: true,
  })
  await page.getByRole("combobox", { name: "Dataset" }).click()
  await page.getByRole("option", { name: "Span calibration" }).click()
  await page.getByRole("button", { name: "Preview case" }).click()
  await page.getByRole("button", { name: "Save case" }).waitFor()
  await page.screenshot({
    path: join(output, "promotion-mobile.png"),
    fullPage: true,
  })
  await page.keyboard.press("Tab")
  assert(
    await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null
    )
  )
  await page.keyboard.press("Escape")
  await page
    .getByRole("dialog", { name: "Create case from span" })
    .waitFor({ state: "hidden" })
  pass("mobile promotion layout, keyboard focus containment and Escape")
  for (const state of ["empty", "error"] as const) {
    await page.route("**/api/datasets?**", (route) =>
      route.fulfill({
        status: state === "error" ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          state === "error"
            ? {
                error: {
                  code: "INTERNAL_ERROR",
                  message: "Datasets could not be loaded.",
                },
              }
            : { data: { items: [], nextCursor: null } }
        ),
      })
    )
    await page.getByRole("button", { name: "Create dataset case" }).click()
    await page
      .getByText(
        state === "error"
          ? "Datasets could not be loaded."
          : "Create a dataset first.",
        { exact: false }
      )
      .waitFor()
    await page.screenshot({
      path: join(output, `promotion-${state}.png`),
      fullPage: true,
    })
    await page.keyboard.press("Escape")
    await page
      .getByRole("dialog", { name: "Create case from span" })
      .waitFor({ state: "hidden" })
    await page.unroute("**/api/datasets?**")
  }
  pass(
    "empty and error states in the real promotion UI with controlled responses"
  )
  await rm(join(output, "server.log"), { force: true })
  await rm(join(output, "failure.png"), { force: true })
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        run: {
          id: run.id,
          url: run.url,
          status: finished.status,
          resultCount: finished.results.length,
          evaluatorVersionId: version.id,
          datasetVersionId: snapshot.id,
        },
        datasetId: ds.id,
        sourceTraceId: trace.id,
        sourceSpanId: span.id,
        note: "Disposable test server and schema are removed after verification; URLs are evidence from this run, not a deployed environment.",
      },
      null,
      2
    )
  )
} catch (error) {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "server.log"), serverLog)
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      await page
        .screenshot({ path: join(output, "failure.png"), fullPage: true })
        .catch(() => {})
      console.error("Browser stopped at", page.url())
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 3000)
      )
    }
  throw error
} finally {
  await browser?.close()
  if (next?.pid) {
    try {
      process.kill(-next.pid, "SIGTERM")
    } catch {
      next.kill("SIGTERM")
    }
    await pause(1000)
  }
  await pools?.db.end()
  await pools?.analyticsDb.end()
  await target.close()
  await rm(directory, { recursive: true, force: true })
}
